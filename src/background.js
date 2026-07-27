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
  FORMS_MAX_LIMIT,
  INTERSECT_MAX_ENTITIES,
  STATUS_V2_TO_V1,
  normalizeProjectId,
} from './aps/forma.js';
import { ApsError } from './aps/errors.js';
import {
  bepaalUitkomst,
  buildCategoryIndex,
  buildStampedNotes,
  formatAsset,
  stampChanged,
  tekstOnderBlok,
} from './stamp.js';
import { APS_CLIENT_ID, ACC_REGION, assertRedirectUri } from './config.js';

const auth = new ApsAuth({ clientId: APS_CLIENT_ID });
const forma = new FormaClient({ auth, region: ACC_REGION });

/**
 * Standaardwaarde van `bevestig` op de probes die écht schrijven.
 *
 * Staat op `true` omdat er op testprojecten gemeten wordt en het bij elke aanroep
 * meetypen van `bevestig: true` daar alleen in de weg zit.
 *
 * **Zet dit terug op `false` zodra er tegen een echt project gedraaid wordt.**
 * De vlag bestaat om te voorkomen dat een half ingetikte consoleregel — met
 * enter erachter voor het af is — een formulier wijzigt. Op één plek, zodat het
 * terugzetten één regel is.
 */
const PROBE_CONFIRM_DEFAULT = true;

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

// -----------------------------------------------------------------------------
// Verrijken: van formulier-id's naar wat er op Selecteren komt te staan
// -----------------------------------------------------------------------------

/**
 * De categorieboom per project, één keer opgehaald.
 *
 * De boom is projectbreed en verandert tijdens een sessie niet. Hem per blok van
 * twintig opnieuw ophalen zou bij honderd formulieren vijf keer dezelfde aanroep
 * zijn.
 */
const categoryCache = new Map();

async function getCategoryIndex(projectId) {
  const key = normalizeProjectId(projectId);
  if (!categoryCache.has(key)) {
    categoryCache.set(
      key,
      forma.listCategories({ projectId }).then(buildCategoryIndex),
    );
  }
  return categoryCache.get(key);
}

/**
 * Verrijkt één blok formulieren en zegt per formulier wat er gaat gebeuren.
 *
 * Eén blok is maximaal 20, want dat is de grens van `relationships:intersect`.
 * De popup snijdt de selectie in blokken en roept dit herhaald aan, zodat de
 * tabel zich vult terwijl de rest nog loopt (design-decisions.md, punt 2).
 *
 * Er wordt hier niets geschreven.
 */
handlers.previewForms = async ({ projectId, formIds }) => {
  if (!projectId) throw new ApsError('client', 'previewForms: projectId ontbreekt.');
  if (!formIds?.length) return { formulieren: [] };
  if (formIds.length > INTERSECT_MAX_ENTITIES) {
    throw new ApsError(
      'client',
      `previewForms neemt maximaal ${INTERSECT_MAX_ENTITIES} formulieren per aanroep.`,
    );
  }

  const containerId = normalizeProjectId(projectId);

  // De formulierrecords en de gekoppelde assets zijn onafhankelijk van elkaar.
  const [{ forms }, assetIdsPerForm, categoryIndex] = await Promise.all([
    forma.listForms({ projectId, ids: formIds, limit: FORMS_MAX_LIMIT }),
    forma.findAssetIdsForForms({ containerId, formIds }),
    getCategoryIndex(projectId),
  ]);

  // Alle asset-id's van dit blok in één keer ophalen; per formulier zou hetzelfde
  // asset bij meerdere formulieren opnieuw opgevraagd worden.
  const alleAssetIds = [...new Set([...assetIdsPerForm.values()].flat())];
  const assets = alleAssetIds.length
    ? await forma.getAssetsByIds({ projectId, ids: alleAssetIds })
    : [];
  const assetById = new Map(assets.map((a) => [String(a.id), a]));

  const formulieren = forms.map((form) => {
    const eigenAssets = (assetIdsPerForm.get(form.id) ?? [])
      .map((id) => assetById.get(String(id)))
      .filter(Boolean);

    // `notes` kan `null` zijn — bij PDF-formulieren is dat de normale waarde.
    const huidig = form.notes ?? '';
    const { notes, level, shown, total, fits } = buildStampedNotes({
      existing: huidig,
      assets: eigenAssets,
      categoryIndex,
    });

    return {
      id: form.id,
      formNum: form.formNum,
      naam: form.name,
      status: form.status,
      templateId: form.formTemplateId,
      gesloten: form.status === 'closed',
      assets: eigenAssets.map((a) => formatAsset(a, categoryIndex)).sort((a, b) => a.localeCompare(b, 'nl')),
      niveau: level,
      huidigeNotities: huidig,
      voorgesteldeNotities: notes,
      ...bepaalUitkomst({
        huidig,
        voorstel: notes,
        assetCount: eigenAssets.length,
        fits,
        shown,
        total,
      }),
    };
  });

  // `GET forms` levert de formulieren in zijn eigen volgorde, niet in die van
  // de `ids` die we meegaven. Zonder dit terugleggen staat de tabel in het
  // paneel in een andere volgorde dan de lijst waar de gebruiker net naar keek.
  const gevraagd = new Map(formIds.map((id, index) => [id, index]));
  formulieren.sort((a, b) => gevraagd.get(a.id) - gevraagd.get(b.id));

  // Een id waar geen formulier bij hoort, hoort niet stil te verdwijnen: dan
  // klopt de selectie niet meer met het project.
  const gevonden = new Set(forms.map((f) => f.id));
  const ontbrekend = formIds.filter((id) => !gevonden.has(id));

  return { formulieren, ontbrekend };
};

// -----------------------------------------------------------------------------
// Het journaal
// -----------------------------------------------------------------------------

const JOURNAAL_SLEUTEL = 'journaal';

/**
 * Hoeveel uitvoeringen we bewaren.
 *
 * Elke regel draagt de oude notities van elk formulier, dus een run over
 * driehonderd formulieren is niet klein. Twintig runs is ruim genoeg om iets van
 * vorige week terug te draaien, zonder de opslag vol te laten lopen.
 */
const JOURNAAL_MAX = 20;

async function leesJournaal() {
  const opslag = await chrome.storage.local.get(JOURNAAL_SLEUTEL);
  return opslag[JOURNAAL_SLEUTEL] ?? [];
}

async function schrijfJournaal(runs) {
  await chrome.storage.local.set({ [JOURNAAL_SLEUTEL]: runs.slice(0, JOURNAAL_MAX) });
}

/**
 * Werkt één uitvoering bij.
 *
 * Lezen, wijzigen, schrijven — elke keer opnieuw, en met opzet niet met een
 * kopie in het geheugen. De service worker mag tussen twee formulieren door
 * afgeschoten worden; wat dan niet in de opslag staat, bestaat niet.
 */
async function werkRunBij(runId, wijzig) {
  const runs = await leesJournaal();
  const index = runs.findIndex((r) => r.id === runId);
  if (index === -1) throw new ApsError('notfound', `Uitvoering ${runId} bestaat niet.`);

  runs[index] = wijzig(runs[index]);
  await schrijfJournaal(runs);
  return runs[index];
}

/** Begint een uitvoering. Levert het id waaronder elk formulier wordt bijgeschreven. */
handlers.startRun = async ({ projectId, projectNaam }) => {
  const run = {
    id: `run-${Date.now()}`,
    projectId,
    projectNaam: projectNaam ?? null,
    gestart: new Date().toISOString(),
    formulieren: [],
  };

  // Uitvoeringen zonder één verwerkt formulier zijn afgebroken vóór er iets
  // gebeurde. Ze opruimen is niet cosmetisch: ze tellen wél mee voor JOURNAAL_MAX
  // en zouden zo een echte, terug te draaien uitvoering uit de lijst duwen.
  const eerdere = (await leesJournaal()).filter((r) => r.formulieren.length > 0);

  await schrijfJournaal([run, ...eerdere]);
  return { runId: run.id };
};

handlers.getJournaal = async () => ({ runs: await leesJournaal() });

/**
 * De naam van het project, als hij te krijgen is.
 *
 * Faalt zacht: de naam is er om de gebruiker te laten zien wélk project hij op
 * het punt staat te stempelen, maar er hangt niets van af. Geeft de aanroep een
 * fout — bijvoorbeeld omdat de app geen toegang heeft tot de Admin-API — dan
 * verdwijnt de regel en werkt de rest gewoon door.
 */
handlers.getProjectNaam = async ({ projectId }) => {
  try {
    const project = await forma.getProject({ projectId });
    return { naam: project?.name ?? null };
  } catch (error) {
    console.warn('[ACC Form Stamper] projectnaam niet opgehaald:', error.message);
    return { naam: null };
  }
};

// -----------------------------------------------------------------------------
// Stempelen
// -----------------------------------------------------------------------------

/**
 * Stempelt één formulier en legt meteen vast hoe het terug moet.
 *
 * Het formulier wordt hier **opnieuw gelezen**, en niet op het voorbeeld
 * vertrouwd. Twee redenen, en de tweede is de belangrijkste:
 *
 *   1. Iemand anders kan het formulier tussen voorbeeld en uitvoering gewijzigd
 *      hebben. Dat hoort een fout op deze rij te zijn, niet een stille
 *      overschrijving van andermans werk.
 *   2. De terugdraairegel moet bewaren wat er **werkelijk stond vlak voor wij
 *      schreven** — niet wat het voorbeeld ooit zag. Een journaal dat een
 *      verouderde waarde teruggeeft, maakt het terugdraaien erger dan het
 *      probleem.
 *
 * De journaalregel gaat weg vóór de melding terugkomt bij het paneel, zodat een
 * afgebroken of gepauzeerde run nooit een gestempeld formulier achterlaat dat
 * niet terug te draaien is (design-decisions.md, punt 8).
 */
handlers.stampForm = async ({ runId, projectId, formId, heropenen = false }) => {
  const form = await findForm(projectId, formId);
  const templateId = form.formTemplateId;

  // `notes` is `null` bij PDF-formulieren; overal als lege tekst behandelen.
  const huidig = form.notes ?? '';
  const wasGesloten = form.status === 'closed';

  const [assetIdsPerForm, categoryIndex] = await Promise.all([
    forma.findAssetIdsForForms({ containerId: normalizeProjectId(projectId), formIds: [formId] }),
    getCategoryIndex(projectId),
  ]);
  const assetIds = assetIdsPerForm.get(formId) ?? [];
  const assets = assetIds.length ? await forma.getAssetsByIds({ projectId, ids: assetIds }) : [];

  const { notes, shown, total, fits } = buildStampedNotes({
    existing: huidig,
    assets,
    categoryIndex,
  });
  const uitkomst = bepaalUitkomst({
    huidig,
    voorstel: notes,
    assetCount: assets.length,
    fits,
    shown,
    total,
  });

  /**
   * Legt de afloop vast in het journaal en geeft hem terug aan het paneel.
   *
   * Vervangt een bestaande regel voor hetzelfde formulier in plaats van er een
   * toe te voegen. Dat is nodig voor "opnieuw proberen": zonder dit zou een
   * formulier dat eerst faalde en daarna slaagde twee keer in de uitvoering
   * staan — één keer als fout en één keer als geschreven. De telling klopt dan
   * niet, en het terugdraaien zou het formulier twee keer aanpakken.
   */
  const noteer = async (regel) => {
    const entry = {
      formId,
      templateId,
      formNum: form.formNum,
      naam: form.name,
      ...regel,
    };

    await werkRunBij(runId, (run) => {
      const formulieren = [...run.formulieren];
      const bestaand = formulieren.findIndex((f) => f.formId === formId);
      if (bestaand === -1) formulieren.push(entry);
      else formulieren[bestaand] = entry;
      return { ...run, formulieren };
    });

    return entry;
  };

  if (uitkomst.tag === 'ongewijzigd') {
    return noteer({ resultaat: 'overgeslagen', melding: 'Overgeslagen - assetregel ongewijzigd' });
  }
  if (uitkomst.tag === 'past-niet') {
    return noteer({
      resultaat: 'fout',
      melding: 'Fout: past niet binnen 8000 tekens - de opmerkingen zijn al te lang',
    });
  }
  if (wasGesloten && !heropenen) {
    return noteer({
      resultaat: 'fout',
      melding: 'Fout: formulier is gesloten - niet in selectie voor heropenen',
    });
  }

  // Wat er onder het blok stond, gaat nu verloren. Achteraf melden (punt 6).
  const verlorenTekst = tekstOnderBlok(huidig);

  try {
    // Een gesloten formulier moet eerst open. Altijd naar `draft`, nooit naar
    // `in_review`: die tussenstap is een instelling van het sjabloon, en staat
    // die uit dan zetten we het formulier in een toestand die het niet kent.
    if (wasGesloten) {
      await forma.updateForm({ projectId, templateId, formId, patch: { status: 'draft' } });
    }

    await forma.setFormNotes({ projectId, templateId, formId, notes });

    if (wasGesloten) {
      await forma.updateForm({ projectId, templateId, formId, patch: { status: 'submitted' } });
    }
  } catch (error) {
    // Loopt het halverwege stuk op een heropend formulier, dan staat het nu open
    // terwijl het dicht was. Dat moet in het journaal, anders merkt niemand het.
    return noteer({
      resultaat: 'fout',
      melding: `Fout: ${error.message}`,
      formulierBlijftOpen: wasGesloten,
      // Er kán al geschreven zijn voordat het herstellen van de status faalde.
      voor: { notes: huidig, gesloten: wasGesloten },
    });
  }

  return noteer({
    resultaat: 'geschreven',
    melding: uitkomst.ingekort
      ? `Opmerkingen bijgewerkt, ingekort naar limiet (${uitkomst.getoond} van ${uitkomst.totaal})`
      : uitkomst.assetregelVervalt
        ? 'Opmerkingen bijgewerkt - assetregel leeggemaakt'
        : 'Opmerkingen bijgewerkt',
    heropend: wasGesloten,
    verlorenTekst: verlorenTekst || undefined,
    // Dit is de terugdraairegel. Wat hier staat, is wat er stond vlak voordat
    // wij schreven.
    voor: { notes: huidig, gesloten: wasGesloten },
    na: { notes },
  });
};

/**
 * Draait één uitvoering terug.
 *
 * Zet de notities terug, en bij een heropend formulier ook de status. Wat níét
 * terugkomt: "gesloten door" en "gesloten op". Die zijn bij het opnieuw sluiten
 * overschreven en zijn onherstelbaar — dat moet de gebruiker gezegd worden vóór
 * hij hierop klikt, niet erna.
 */
handlers.undoRun = async ({ runId }) => {
  const runs = await leesJournaal();
  const run = runs.find((r) => r.id === runId);
  if (!run) throw new ApsError('notfound', `Uitvoering ${runId} bestaat niet.`);

  const teruggedraaid = [];
  const mislukt = [];

  for (const entry of run.formulieren) {
    if (entry.resultaat !== 'geschreven' || !entry.voor) continue;

    const { projectId } = run;
    const { templateId, formId } = entry;

    try {
      if (entry.voor.gesloten) {
        await forma.updateForm({ projectId, templateId, formId, patch: { status: 'draft' } });
      }
      await forma.setFormNotes({ projectId, templateId, formId, notes: entry.voor.notes });
      if (entry.voor.gesloten) {
        await forma.updateForm({ projectId, templateId, formId, patch: { status: 'submitted' } });
      }
      teruggedraaid.push(entry.formId);
    } catch (error) {
      mislukt.push({ formId: entry.formId, naam: entry.naam, melding: error.message });
    }
  }

  await werkRunBij(runId, (r) => ({
    ...r,
    teruggedraaidOp: new Date().toISOString(),
    // Half gelukt is niet teruggedraaid: anders verdwijnt de knop terwijl er nog
    // formulieren op de nieuwe tekst staan.
    teruggedraaid: mislukt.length === 0,
  }));

  return { teruggedraaid: teruggedraaid.length, mislukt };
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
  const { projectId, formId, bevestig = PROBE_CONFIRM_DEFAULT } = withUrl(payload);
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
    bevestig = PROBE_CONFIRM_DEFAULT,
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
 * De derde ongedocumenteerde aanname: zijn PDF-formulieren te stempelen?
 *
 * `api-notes.md` zegt van niet, maar dat komt uit de referentie van Autodesk en
 * is nooit gemeten — net als de twee aannames die op 27-07-2026 wél gemeten
 * werden en allebei de andere kant op vielen. De ACC-interface spreekt de
 * referentie bovendien tegen: een PDF-formulier heeft gewoon een
 * Formulierdetails-paneel met een ingevuld notitieveld en een referentiesectie.
 *
 * Deze probe doet twee dingen, en de eerste kan zonder iets te schrijven:
 *
 *   1. **Herkennen.** Dumpt het rauwe v2-record en zet de velden van dit
 *      formulier naast die van een gewoon formulier. Zonder een veld dat
 *      "dit is een PDF-formulier" zegt, kan de tool ze niet apart behandelen —
 *      dus is dit net zo belangrijk als de schrijftest zelf.
 *   2. **Schrijven.** PATCH notities → opnieuw lezen → terugzetten → opnieuw
 *      lezen. Opnieuw lezen is geen overbodige stap: bij `probeReopen` bleek
 *      dat wat de PATCH teruggeeft niet hetzelfde is als wat er staat.
 *
 * Zoeken kan op id of op naam:
 *
 *   await stamper.probePdfForm({ projectId: '948dda3b-…', zoek: 'WT II_307N' })
 *   await stamper.probePdfForm({ projectId: '948dda3b-…', zoek: 'WT II_307N', bevestig: true })
 *
 * Zonder `bevestig: true` wordt er niets geschreven.
 */
handlers.probePdfForm = async (payload) => {
  const {
    projectId,
    formId,
    templateId: templateIdUitUrl,
    zoek,
    bevestig = PROBE_CONFIRM_DEFAULT,
  } = withUrl(payload);

  // Het doelformulier: op id als we die hebben, anders op naam.
  let form;
  if (formId) {
    form = await findForm(projectId, formId);
  } else if (zoek) {
    const { forms } = await forma.listForms({ projectId, search: zoek, limit: 10 });
    if (forms.length === 0) {
      throw new ApsError('notfound', `Geen formulier gevonden voor "${zoek}".`);
    }
    form = forms[0];
  } else {
    throw new ApsError('client', 'Geef een formId, een url, of zoek: "<naam>" mee.');
  }

  // Een tweede formulier van een ánder sjabloon, puur als vergelijkingsmateriaal.
  // Welk veld een PDF-formulier verraadt, is alleen te zien door twee records
  // naast elkaar te leggen.
  const { forms: steekproef } = await forma.listForms({ projectId, limit: 25 });
  const ander = steekproef.find((f) => f.formTemplateId !== form.formTemplateId);

  const velden = (record) =>
    Object.fromEntries(
      Object.entries(record ?? {}).map(([k, v]) => [
        k,
        v === null || typeof v !== 'object' ? v : Array.isArray(v) ? `[${v.length}]` : '{…}',
      ]),
    );

  const rapport = {
    formulier: { id: form.id, formNum: form.formNum, name: form.name, status: form.status },
    templateId: form.formTemplateId,
    // Het record is leidend voor de PATCH, de URL dient als controle. Lopen ze
    // uiteen, dan klopt onze aanname over dat URL-segment niet — en juist bij
    // een PDF-formulier is dat het narekenen waard.
    templateIdUitUrl,
    templateIdKlopt: templateIdUitUrl ? templateIdUitUrl === form.formTemplateId : undefined,
    bewerkbareStatus: form.status === 'inProgress' || form.status === 'inReview',
    huidigeNotities: form.notes ?? '',
    // Hier moet uit blijken wáár een PDF-formulier zich verraadt.
    herkenning: {
      ditFormulier: velden(form),
      terVergelijking: ander ? velden(ander) : 'geen formulier van een ander sjabloon gevonden',
      alleenHier: ander
        ? Object.keys(form).filter((k) => !(k in ander))
        : undefined,
      alleenDaar: ander
        ? Object.keys(ander).filter((k) => !(k in form))
        : undefined,
    },
  };

  if (!bevestig) {
    return {
      geschreven: false,
      reden: 'Geef bevestig: true mee om de schrijftest te doen.',
      ...rapport,
    };
  }
  if (!rapport.bewerkbareStatus) {
    return {
      geschreven: false,
      reden:
        `Formulier staat op "${form.status}". Deze probe meet of een PDF-formulier ` +
        'te bewerken is, niet of een gesloten formulier dat is — pak een formulier ' +
        'dat openstaat, anders meten we het verkeerde.',
      ...rapport,
    };
  }

  const origineel = form.notes ?? '';
  const proef = `probe pdf-notities ${new Date().toISOString()}`;
  const stappen = [];

  const stap = async (naam, fn) => {
    try {
      const resultaat = await fn();
      stappen.push({ stap: naam, gelukt: true });
      return { gelukt: true, resultaat };
    } catch (error) {
      stappen.push({
        stap: naam,
        gelukt: false,
        status: error?.status,
        melding: error?.message,
        // De rauwe tekst van Autodesk zegt of het op het PDF-karakter stuit of
        // op iets heel anders.
        antwoord: typeof error?.detail === 'string' ? error.detail.slice(0, 500) : undefined,
      });
      return { gelukt: false, error };
    }
  };

  const schrijf = await stap('notities patchen', () =>
    forma.updateForm({
      projectId,
      templateId: form.formTemplateId,
      formId: form.id,
      patch: { notes: proef },
    }),
  );

  // Wat de PATCH teruggeeft is niet per se wat er staat.
  const naSchrijven = await stap('lezen na schrijven', () => findForm(projectId, form.id));
  const echtGeschreven = naSchrijven.gelukt && naSchrijven.resultaat.notes === proef;

  // Altijd terugzetten, ook als de controle hierboven tegenviel — er kan best
  // geschreven zijn zonder dat het teruglezen klopte.
  let hersteld = false;
  if (schrijf.gelukt) {
    const terug = await stap('notities terugzetten', () =>
      forma.updateForm({
        projectId,
        templateId: form.formTemplateId,
        formId: form.id,
        patch: { notes: origineel },
      }),
    );
    const naHerstel = terug.gelukt
      ? await stap('lezen na terugzetten', () => findForm(projectId, form.id))
      : { gelukt: false };
    hersteld = naHerstel.gelukt && (naHerstel.resultaat.notes ?? '') === origineel;
  }

  return {
    conclusie: echtGeschreven
      ? 'PDF-formulieren zijn wél te stempelen. De regel "uit de selectie filteren" in api-notes.md vervalt.'
      : 'Notities schrijven lukt niet op dit formulier. Zie stappen voor de reden — let op of die reden echt over PDF gaat.',
    geschreven: echtGeschreven,
    hersteld,
    // Blijft dit op false staan, dan staat de proeftekst nog in het formulier
    // en moet die met de hand weg.
    notitieBlijftStaan: schrijf.gelukt && !hersteld,
    origineleNotities: origineel,
    stappen,
    ...rapport,
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

// De `chrome.action.onClicked`-listener die hier stond, meldde aan bij een klik
// op het icoon. Die klik opent nu de popup, en dan vuurt `onClicked` niet meer —
// aanmelden gebeurt via de knop op stap 1.
