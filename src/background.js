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
import { FormaClient, FORM_DOMAIN, FORM_TYPE, normalizeProjectId } from './aps/forma.js';
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
handlers.previewStamp = async ({ projectId, formId }) => {
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
handlers.writeStamp = async ({ projectId, formId, bevestig = false }) => {
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
globalThis.stamper = { ...handlers, auth, forma };

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
