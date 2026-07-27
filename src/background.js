/**
 * Service worker — de enige plek die met Autodesk praat.
 *
 * Het paneel op de ACC-pagina heeft zelf geen toegang tot `chrome.identity`, en
 * aanroepen naar developer.api.autodesk.com lopen daar bovendien tegen CORS aan.
 * Alles gaat dus via berichten naar deze worker.
 *
 * Voorlopig zit hier alleen het aanmelden in. De stempellogica komt later; die
 * hoort hier ook thuis, niet in het paneel.
 */

import { ApsAuth } from './aps/auth.js';
import {
  FormaClient,
  FORM_DOMAIN,
  FORM_TYPE,
  STATUS_V2_TO_V1,
  normalizeProjectId,
} from './aps/forma.js';
import { ApsError } from './aps/errors.js';
import { buildCategoryIndex, buildStampedNotes, formatAsset, stampChanged } from './stamp.js';
import { APS_CLIENT_ID, ACC_REGION, assertRedirectUri } from './config.js';

const auth = new ApsAuth({ clientId: APS_CLIENT_ID });
const forma = new FormaClient({ auth, region: ACC_REGION });

// -----------------------------------------------------------------------------
// Berichten vanaf het paneel
// -----------------------------------------------------------------------------

/** @type {Record<string, (payload: any) => Promise<any>>} */
const handlers = {
  async status() {
    return { signedIn: await auth.isSignedIn(), redirect: assertRedirectUri() };
  },

  async signIn() {
    const check = assertRedirectUri();
    if (!check.ok) {
      // Zonder deze controle krijg je van Autodesk alleen "invalid redirect_uri",
      // zonder te zien welke URL de browser dan wél gebruikt.
      throw new ApsError(
        'auth',
        'De callback-URL van deze extensie komt niet overeen met wat bij Autodesk ' +
          `geregistreerd staat. Verwacht: ${check.expected} — nu: ${check.actual}`,
      );
    }
    await auth.signIn();
    return { signedIn: true };
  },

  async signOut() {
    await auth.signOut();
    return { signedIn: false };
  },

  /**
   * Rookproef: haalt één pagina formulieren op. Bedoeld om te controleren of
   * aanmelden, scopes en projecttoegang kloppen — nog niet om iets mee te doen.
   */
  async probeForms({ projectId }) {
    const { forms, totalResults } = await forma.listForms({ projectId, limit: 5 });
    return {
      totalResults,
      sample: forms.map((f) => ({
        id: f.id,
        formNum: f.formNum,
        name: f.name,
        status: f.status,
        formTemplateId: f.formTemplateId,
      })),
    };
  },
};

/**
 * Haalt één formulier op.
 *
 * De v2-API heeft geen "haal één formulier op"-endpoint, maar `GET forms`
 * accepteert wel een `ids`-parameter. Dat scheelt het doorbladeren van de hele
 * lijst — en werkt straks net zo goed voor een selectie van vijftig.
 */
async function findForm(projectId, formId) {
  const { forms } = await forma.listForms({ projectId, ids: [formId] });
  const form = forms.find((f) => f.id === formId);
  if (!form) throw new ApsError('notfound', `Formulier ${formId} niet gevonden in dit project.`);
  return form;
}

/**
 * Stelt het stempel samen zonder iets te schrijven.
 *
 * Dit is de kern van het voorbeeldscherm uit de UX: huidige notities naast
 * voorgestelde notities, en verder niets.
 */
handlers.previewStamp = async (payload) => {
  const { projectId, formId } = withUrl(payload);
  const form = await findForm(projectId, formId);

  const perForm = await forma.findAssetIdsForForms({
    containerId: normalizeProjectId(projectId),
    formIds: [formId],
  });
  const assetIds = perForm.get(formId) ?? [];

  const [assets, categories] = await Promise.all([
    assetIds.length ? forma.getAssetsByIds({ projectId, ids: assetIds }) : [],
    forma.listCategories({ projectId }),
  ]);

  const categoryIndex = buildCategoryIndex(categories);
  const huidig = form.notes ?? '';
  const { notes, level, shown, total, fits } = buildStampedNotes({
    existing: huidig,
    assets,
    categoryIndex,
  });

  return {
    formulier: { id: form.id, formNum: form.formNum, name: form.name, status: form.status },
    templateId: form.formTemplateId,
    bewerkbaar: form.status === 'inProgress' || form.status === 'inReview',
    assets: assets.map((a) => formatAsset(a, categoryIndex)),
    gevondenAssetIds: assetIds.length,
    opgehaaldeAssets: assets.length,
    huidigeNotities: huidig,
    voorgesteldeNotities: notes,
    wijzigt: stampChanged(huidig, notes),
    detail: { niveau: level, getoond: shown, totaal: total, pastBinnenLimiet: fits },
  };
};

/**
 * Schrijft het stempel écht weg. Eén formulier tegelijk.
 *
 * Vraagt om `bevestig: true` zodat een half afgemaakte console-regel niets kan
 * aanrichten. Geeft de oude notities terug — bewaar die als je wilt kunnen
 * terugdraaien, want de tool houdt nog geen journaal bij.
 */
handlers.writeStamp = async (payload) => {
  const { projectId, formId, bevestig = false } = withUrl(payload);
  const preview = await handlers.previewStamp({ projectId, formId });

  if (!bevestig) {
    return { geschreven: false, reden: 'Geef bevestig: true mee om te schrijven.', preview };
  }
  if (!preview.bewerkbaar) {
    return {
      geschreven: false,
      reden: `Formulier staat op "${preview.formulier.status}" en is niet bewerkbaar.`,
      preview,
    };
  }
  if (!preview.detail.pastBinnenLimiet) {
    return { geschreven: false, reden: 'Past niet binnen 8000 tekens.', preview };
  }

  await forma.updateForm({
    projectId,
    templateId: preview.templateId,
    formId,
    patch: { notes: preview.voorgesteldeNotities },
  });

  return {
    geschreven: true,
    terugdraaienMet: { projectId, templateId: preview.templateId, formId, notes: preview.huidigeNotities },
    voor: preview.huidigeNotities,
    na: preview.voorgesteldeNotities,
  };
};

/** Zet de notities terug naar een eerdere waarde. */
handlers.restoreNotes = async ({ projectId, templateId, formId, notes }) => {
  await forma.updateForm({ projectId, templateId, formId, patch: { notes } });
  return { hersteld: true };
};

/**
 * Diagnose bij een 403 van de relatieservice.
 *
 * Probeert dezelfde dienst op een paar manieren en rapporteert alleen de
 * statuscodes. Zo is te zien wáár het misgaat:
 *
 *   - `utility:writable` heeft geen container nodig. Lukt die wel en de
 *     container-aanroep niet, dan ligt het aan de container-id.
 *   - Lukt geen van beide, dan ligt het aan het token of aan de app-toegang.
 *   - Verschilt het per regio, dan is het de routering.
 */
handlers.probeRelationshipAccess = async ({ projectId }) => {
  const token = await auth.getAccessToken();
  const containerId = normalizeProjectId(projectId);
  const base = 'https://developer.api.autodesk.com/bim360/relationship/v2';

  const search =
    `${base}/containers/${containerId}/relationships:search` +
    `?domain=${FORM_DOMAIN}&type=${FORM_TYPE}&pageLimit=1`;

  const cases = [
    ['writable, regio EMEA', `${base}/utility/relationships:writable`, 'EMEA'],
    ['writable, geen regio', `${base}/utility/relationships:writable`, null],
    ['writable, regio US', `${base}/utility/relationships:writable`, 'US'],
    ['search, regio EMEA', search, 'EMEA'],
    ['search, geen regio', search, null],
    ['search, regio US', search, 'US'],
  ];

  const results = [];
  for (const [label, url, region] of cases) {
    const headers = { Authorization: `Bearer ${token}` };
    if (region) headers['x-ads-region'] = region;

    try {
      const response = await fetch(url, { headers });
      const body = await response.text();
      results.push({
        test: label,
        status: response.status,
        antwoord: body.slice(0, 200),
      });
    } catch (error) {
      results.push({ test: label, status: 'netwerkfout', antwoord: error.message });
    }
  }

  console.table(results.map(({ test, status }) => ({ test, status })));
  return { containerId, results };
};

/**
 * Rookproef voor de relatieservice.
 *
 * Zoekt álle relaties in het project waar een formulier aan meedoet, zonder een
 * formulier-id op te geven. Komt hier iets uit, dan klopt de domeinnaam
 * `autodesk-construction-form` en werkt het zoeken vanaf de formulierkant —
 * de grootste openstaande aanname in het ontwerp.
 *
 * Levert het niets op, dan zegt dat nog niets over de richting: het kan ook zijn
 * dat er in dit project simpelweg geen assets aan formulieren hangen.
 */
handlers.probeRelationships = async ({ projectId, limit = 10 }) => {
  const containerId = normalizeProjectId(projectId);
  const found = [];

  for await (const relationship of forma.searchRelationships({
    containerId,
    domain: FORM_DOMAIN,
    type: FORM_TYPE,
    pageLimit: 20,
  })) {
    found.push({
      isDeleted: relationship.isDeleted,
      entities: (relationship.entities ?? []).map((e) => `${e.domain}/${e.type}/${e.id}`),
    });
    if (found.length >= limit) break;
  }

  return { containerId, aantal: found.length, relaties: found };
};

/**
 * Haalt de id's uit een ACC-formulier-URL.
 *
 * De adresbalk van een geopend formulier draagt alle drie de id's die de
 * schrijfaanroep nodig heeft:
 *
 *   https://acc.autodesk.eu/build/forms/projects/<projectId>/field-reports/<templateId>/reports/<formId>
 *
 * Dat scheelt overtypen én een lijstaanroep. De `projectId` staat er zonder
 * `b.`-voorvoegsel in, wat precies is wat de Forms- en Assets-API willen.
 *
 * @param {string} url
 * @returns {{projectId: string, templateId?: string, formId?: string}}
 */
export function parseFormUrl(url) {
  const project = /\/projects\/(b\.)?([0-9a-f-]{36})/i.exec(url);
  if (!project) {
    throw new ApsError(
      'client',
      'Geen project-id in deze URL. Verwacht een adres uit ACC Build, ' +
        'zoiets als .../build/forms/projects/<id>/field-reports/<sjabloon>/reports/<formulier>',
    );
  }

  const report = /\/field-reports\/([0-9a-f-]{36})\/reports\/([0-9a-f-]{36})/i.exec(url);

  return {
    projectId: project[2],
    templateId: report?.[1],
    formId: report?.[2],
  };
}

/**
 * Vult ontbrekende id's aan uit een meegegeven `url`.
 *
 * Zo mag elke handler hieronder óf losse id's krijgen, óf een geplakte URL.
 * Expliciet meegegeven id's winnen altijd van wat er in de URL staat.
 */
function withUrl({ url, ...rest }) {
  if (!url) return rest;
  const uit = parseFormUrl(url);
  return { ...uit, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
}

/**
 * De openstaande vraag uit `api-notes.md`: kan een gesloten formulier via de API
 * heropend worden?
 *
 * De referentie zegt dat gesloten formulieren "no longer editable" zijn, maar
 * niet of dat óók voor het statusveld zelf geldt. Dat is alleen met een echte
 * aanroep uit te maken, dus doet deze probe precies dat — op één testformulier,
 * en met alle tussenstappen in het rapport.
 *
 * Wat er gebeurt:
 *
 *   1. formulier lezen (v2) en de status vertalen naar v1
 *   2. PATCH status → `draft`; lukt dat niet, dan nog een poging met `in_review`
 *   3. opnieuw lezen — wat de PATCH teruggeeft is niet hetzelfde als wat er staat
 *   4. optioneel de notities patchen, om te zien of het formulier écht bewerkbaar is
 *   5. weer sluiten (`submitted`), en opnieuw lezen
 *
 * Stap 5 is de tweede reden om dit te draaien: in het rapport staan de rauwe
 * formulierrecords van vóór en ná, dus daar is aan af te lezen of "gesloten
 * door" en "gesloten op" bij het opnieuw sluiten overschreven worden. Die zorg
 * uit `workflow.md` is nu nog een vermoeden.
 *
 * Dit schrijft dus écht. Gebruik een wegwerpformulier, geen echte oplevering:
 *
 *   await stamper.probeReopen({ projectId: 'b.xxx', formId: 'yyy', bevestig: true })
 *
 * Loopt het halverwege vast, dan kan het formulier open blijven staan. Het
 * rapport zegt dat er dan bij (`formulierBlijftOpen`).
 */
handlers.probeReopen = async (payload) => {
  const {
    projectId,
    formId,
    templateId: templateIdUitUrl,
    bevestig = false,
    testNotitie = false,
    weerSluiten = true,
  } = withUrl(payload);

  const voor = await findForm(projectId, formId);
  // Het formulierrecord is hier de bron, niet de URL: `formTemplateId` uit v2 is
  // wat de v1-PATCH in het pad wil hebben. De URL-waarde dient als controle —
  // lopen ze uiteen, dan klopt onze aanname over dat URL-segment niet.
  const templateId = voor.formTemplateId;
  const statusV1 = STATUS_V2_TO_V1[voor.status] ?? voor.status;
  const templateIdKlopt = templateIdUitUrl ? templateIdUitUrl === templateId : undefined;

  if (!bevestig) {
    return {
      geschreven: false,
      reden: 'Geef bevestig: true mee. Deze probe wijzigt het formulier echt.',
      formulier: { id: voor.id, formNum: voor.formNum, name: voor.name },
      status: { v2: voor.status, v1: statusV1 },
      templateId,
      templateIdUitUrl,
      templateIdKlopt,
      bruikbaar: voor.status === 'closed',
    };
  }
  if (voor.status !== 'closed') {
    return {
      geschreven: false,
      reden:
        `Formulier staat op "${voor.status}" en is dus niet gesloten. ` +
        'Sluit eerst een testformulier in ACC — anders meet deze probe niets.',
      status: { v2: voor.status, v1: statusV1 },
    };
  }

  const stappen = [];

  /** Voert één stap uit en houdt de fout vast in plaats van hem te laten vallen. */
  const stap = async (naam, fn) => {
    try {
      const resultaat = await fn();
      stappen.push({ stap: naam, gelukt: true, resultaat });
      return { gelukt: true, resultaat };
    } catch (error) {
      stappen.push({
        stap: naam,
        gelukt: false,
        status: error?.status,
        melding: error?.message,
        // De rauwe tekst van Autodesk is hier het interessantst: die zegt of het
        // op de status stuit of op iets anders.
        antwoord: typeof error?.detail === 'string' ? error.detail.slice(0, 500) : undefined,
      });
      return { gelukt: false, error };
    }
  };

  const patchStatus = (status) =>
    stap(`status → ${status}`, () =>
      forma.updateForm({ projectId, templateId, formId, patch: { status } }),
    );
  const lees = (naam) => stap(naam, () => findForm(projectId, formId));

  // 2. Heropenen — altijd naar `draft` (In Progress), nooit naar `in_review`.
  //    De beoordelingsstap is een instelling van het sjabloon: staat die uit,
  //    dan zetten we een formulier in een toestand die het sjabloon niet kent.
  //    Lukt `draft` niet, dan is het antwoord "nee", niet "probeer wat anders".
  await patchStatus('draft');

  // 3. Wat de PATCH teruggeeft is niet per se wat er staat.
  const naHeropenen = await lees('lezen na heropenen');
  const werkelijkOpen =
    naHeropenen.gelukt && ['inProgress', 'inReview'].includes(naHeropenen.resultaat.status);

  // 4. Status terug op `draft` zegt nog niet dat de velden meedoen.
  if (testNotitie && werkelijkOpen) {
    const proef = `probe heropenen ${new Date().toISOString()}`;
    await stap('notities patchen', () =>
      forma.updateForm({ projectId, templateId, formId, patch: { notes: proef } }),
    );
    await stap('notities terugzetten', () =>
      forma.updateForm({ projectId, templateId, formId, patch: { notes: voor.notes ?? '' } }),
    );
  }

  // 5. Weer dichtdoen, en kijken wat dat met de sluitgegevens doet.
  let na = naHeropenen;
  if (weerSluiten && werkelijkOpen) {
    await patchStatus('submitted');
    na = await lees('lezen na sluiten');
  }

  const weerGesloten = na.gelukt && na.resultaat.status === 'closed';

  return {
    conclusie: werkelijkOpen
      ? 'Heropenen kan. De optie "gesloten formulieren meenemen" blijft overeind.'
      : 'Heropenen lukt niet via de API. De optie vervalt; filter gesloten formulieren weg.',
    heropenen: {
      gelukt: werkelijkOpen,
      statusNaHeropenen: naHeropenen.gelukt ? naHeropenen.resultaat.status : undefined,
    },
    weerGesloten,
    formulierBlijftOpen: werkelijkOpen && weerSluiten && !weerGesloten,
    templateIdKlopt,
    stappen,
    // Voor en na naast elkaar: hier is af te lezen of "gesloten door"/"gesloten
    // op" bij het opnieuw sluiten overschreven zijn.
    records: { voor, na: na.gelukt ? na.resultaat : undefined },
  };
};

/**
 * Handvat voor de console van de service worker.
 *
 * Berichten via `chrome.runtime.sendMessage` komen niet aan bij de extensie die
 * ze zelf verstuurt, dus vanuit deze console is de bovenstaande handlers-tabel
 * anders niet te bereiken. Hiermee wel:
 *
 *   await stamper.probeForms({ projectId: 'b.xxxx' })
 *   await stamper.status()
 *   await stamper.signOut()
 *
 * Alleen bedoeld om handmatig te testen.
 */
globalThis.stamper = { ...handlers, auth, forma, parseFormUrl };

// Draait bij elke start van de service worker. Staat deze regel niet in de
// console waar je `stamper` intikt, dan kijk je naar de verkeerde console —
// die van de ACC-pagina bijvoorbeeld, en daar bestaat `stamper` niet.
console.log('[ACC Form Stamper] service worker geladen —', Object.keys(handlers).join(', '));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];

  if (!handler) {
    sendResponse({ ok: false, error: { message: `Onbekend bericht: ${message?.type}` } });
    return false;
  }

  handler(message.payload ?? {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error('[ACC Form Stamper]', message.type, error);
      sendResponse({
        ok: false,
        error: {
          message: error?.message ?? 'Er ging iets mis.',
          kind: error instanceof ApsError ? error.kind : 'client',
          needsSignIn: error instanceof ApsError ? error.needsSignIn : false,
        },
      });
    });

  // Houdt het berichtenkanaal open voor het asynchrone antwoord.
  return true;
});

// -----------------------------------------------------------------------------
// Klik op het extensie-icoon — tijdelijk, tot het paneel er is
// -----------------------------------------------------------------------------

chrome.action.onClicked.addListener(async () => {
  const check = assertRedirectUri();
  console.log('[ACC Form Stamper] callback-URL:', check.actual, check.ok ? '(komt overeen)' : '(WIJKT AF)');

  try {
    if (await auth.isSignedIn()) {
      console.log('[ACC Form Stamper] al aangemeld');
      return;
    }
    await auth.signIn();
    console.log('[ACC Form Stamper] aanmelden gelukt');
  } catch (error) {
    console.error('[ACC Form Stamper] aanmelden mislukt:', error);
  }
});
