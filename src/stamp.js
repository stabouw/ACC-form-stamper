/**
 * Het stempel: van asset-id's naar de tekst die in het notitieveld komt.
 *
 * Alles hier is puur — geen netwerk, geen browser. Dat is met opzet: dit is de
 * logica die je wilt kunnen nalezen en testen zonder ACC erbij.
 *
 * Formaat (zie docs/workflow.md):
 *
 *     Controle uitgevoerd op 12-3, klep vervangen.
 *
 *     --- gekoppelde assets (26-07-2026) ----
 *     asset A (1->Ba->24), asset B (1->Ba->23)
 *
 * Alles bóven de markering is van de gebruiker en blijft staan. Alles eronder is
 * van de tool en wordt in zijn geheel vervangen.
 */

/** Documented Max length op het notes-veld. */
export const NOTES_MAX_LENGTH = 8000;

/**
 * Herkent de markeringsregel.
 *
 * Op patroon, niet op letterlijke tekst: de datum verschilt per run. Zou je op
 * de hele regel vergelijken, dan zou de tool zijn eigen blok van gisteren niet
 * meer terugvinden en het als gebruikerstekst laten staan.
 */
const MARKER_RE = /^-{3} gekoppelde assets \(\d{2}-\d{2}-\d{4}\) -{4}$/m;

/**
 * Scheidingsteken tussen categorieniveaus.
 *
 * ` > ` en niet `->`, omdat ACC de categorie van een asset zelf ook zo toont
 * (in het referentiepaneel van een formulier staat `C > CC`). Het stempel leest
 * daarmee hetzelfde als de rest van de interface.
 */
const PATH_SEPARATOR = ' > ';
const ITEM_SEPARATOR = ', ';

/** @param {Date} date */
export function formatStampDate(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${date.getFullYear()}`;
}

function markerLine(date) {
  return `--- gekoppelde assets (${formatStampDate(date)}) ----`;
}

// -----------------------------------------------------------------------------
// Categorieën
// -----------------------------------------------------------------------------

/**
 * Zet de platte categorielijst om in `categoryId → pad`.
 *
 * De API levert per categorie alleen een `parentId`; het volledige pad moet je
 * zelf omhoog aflopen. Eén keer per run doen en vasthouden.
 *
 * Bestand tegen een categorie die naar zichzelf of naar een kring verwijst —
 * dat hoort niet voor te komen, maar een oneindige lus in een achtergrondproces
 * is een naar soort storing.
 *
 * **De onzichtbare wortelcategorie wordt weggelaten.** ACC hangt alle
 * categorieën onder één wortel (in dit account `ROOT`) die nergens in de
 * interface te zien is. Die in het stempel zetten levert bij elke asset dezelfde
 * betekenisloze eerste stap op, en kost bovendien tekens binnen de 8000.
 *
 * Het weglaten gebeurt alleen als er precies één categorie zonder ouder is. Zijn
 * er meerdere, dan zijn het echte topcategorieën en blijven ze staan.
 *
 * @param {Array<{id: string, name: string, parentId?: string|null}>} categories
 * @param {object} [options]
 * @param {boolean} [options.dropRoot]
 * @returns {Map<string, {name: string, path: string[]}>}
 */
export function buildCategoryIndex(categories, { dropRoot = true } = {}) {
  const byId = new Map(categories.map((c) => [String(c.id), c]));

  const roots = categories.filter((c) => c.parentId == null || !byId.has(String(c.parentId)));
  const rootId = dropRoot && roots.length === 1 ? String(roots[0].id) : null;

  /** @type {Map<string, {name: string, path: string[]}>} */
  const index = new Map();

  for (const category of categories) {
    const path = [];
    const seen = new Set();

    let current = category;
    while (current && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      if (String(current.id) !== rootId) path.unshift(current.name);
      const parentId = current.parentId == null ? null : String(current.parentId);
      current = parentId ? byId.get(parentId) : null;
    }

    index.set(String(category.id), { name: category.name, path });
  }

  return index;
}

// -----------------------------------------------------------------------------
// Assets beschrijven
// -----------------------------------------------------------------------------

/**
 * Eén asset als `naam (pad)`.
 *
 * De naam is `clientAssetId` — dat is wat in de Assets-UI als "Asset ID" op het
 * scherm staat. Assets hebben geen apart `name`-veld.
 *
 * @param {{clientAssetId?: string, id: string, categoryId?: string}} asset
 * @param {Map<string, {name: string, path: string[]}>} categoryIndex
 * @param {'full'|'leaf'|'none'} level
 */
export function formatAsset(asset, categoryIndex, level = 'full') {
  const name = asset.clientAssetId?.trim() || asset.id;
  if (level === 'none') return name;

  const entry = asset.categoryId == null ? undefined : categoryIndex.get(String(asset.categoryId));
  if (!entry || entry.path.length === 0) return name;

  const path = level === 'leaf' ? entry.path.slice(-1) : entry.path;
  return `${name} (${path.join(PATH_SEPARATOR)})`;
}

/**
 * De assetregel, in vaste volgorde.
 *
 * Sorteren op naam is geen cosmetiek: zonder vaste volgorde levert dezelfde
 * selectie bij een tweede run een andere string op, en dan denkt de tool dat er
 * iets veranderd is en schrijft hij opnieuw.
 */
function assetLine(assets, categoryIndex, level, limit) {
  const items = assets
    .map((asset) => formatAsset(asset, categoryIndex, level))
    .sort((a, b) => a.localeCompare(b, 'nl'));

  if (limit == null || limit >= items.length) return items.join(ITEM_SEPARATOR);

  const kept = items.slice(0, limit);
  return `${kept.join(ITEM_SEPARATOR)} (+${items.length - limit} meer)`;
}

// -----------------------------------------------------------------------------
// Notities samenstellen
// -----------------------------------------------------------------------------

/**
 * Splitst bestaande notities in het deel van de gebruiker en het deel van ons.
 *
 * @param {string} notes
 * @returns {{userPart: string, hasStamp: boolean}}
 */
export function splitNotes(notes = '') {
  const match = MARKER_RE.exec(notes);
  if (!match) return { userPart: notes.trimEnd(), hasStamp: false };
  return { userPart: notes.slice(0, match.index).trimEnd(), hasStamp: true };
}

/**
 * Bouwt de nieuwe notitietekst.
 *
 * Loopt de afbouwladder af tot het geheel binnen de limiet past:
 *   1. volledig pad
 *   2. alleen het laatste niveau
 *   3. lijst inkorten, afgesloten met `(+N meer)`
 *
 * @param {object} params
 * @param {string} [params.existing]  Huidige notities van het formulier.
 * @param {Array<object>} params.assets
 * @param {Map<string, {name: string, path: string[]}>} params.categoryIndex
 * @param {Date} [params.date]
 * @param {number} [params.maxLength]
 * @returns {{notes: string, level: 'full'|'leaf', shown: number, total: number, fits: boolean}}
 */
export function buildStampedNotes({
  existing = '',
  assets,
  categoryIndex,
  date = new Date(),
  maxLength = NOTES_MAX_LENGTH,
} = {}) {
  const { userPart } = splitNotes(existing);
  const marker = markerLine(date);

  const assemble = (line) => (userPart ? `${userPart}\n\n${marker}\n${line}` : `${marker}\n${line}`);

  for (const level of /** @type {const} */ (['full', 'leaf'])) {
    const notes = assemble(assetLine(assets, categoryIndex, level, null));
    if (notes.length <= maxLength) {
      return { notes, level, shown: assets.length, total: assets.length, fits: true };
    }
  }

  // Beide volledige varianten zijn te lang: inkorten op het kortste formaat.
  // Aflopend tellen zodat we zoveel mogelijk assets tonen die nog passen.
  for (let limit = assets.length - 1; limit >= 1; limit--) {
    const notes = assemble(assetLine(assets, categoryIndex, 'leaf', limit));
    if (notes.length <= maxLength) {
      return { notes, level: 'leaf', shown: limit, total: assets.length, fits: true };
    }
  }

  // Zelfs één asset past niet meer — dan is de gebruikerstekst zelf al te lang.
  // Niets schrijven en dit aan de gebruiker melden; afkappen zou zijn tekst
  // opeten.
  const notes = assemble(assetLine(assets, categoryIndex, 'leaf', 1));
  return { notes, level: 'leaf', shown: 1, total: assets.length, fits: false };
}

/**
 * Is er iets te doen voor dit formulier?
 *
 * Vergelijkt op de **assetregel**, niet op de datum. Zou je de hele tekst
 * vergelijken, dan lijkt elk formulier de dag na het stempelen verouderd en
 * schrijft de tool bij elke run alles opnieuw.
 *
 * @param {string} current
 * @param {string} proposed
 */
export function stampChanged(current = '', proposed = '') {
  const body = (notes) => {
    const match = MARKER_RE.exec(notes);
    if (!match) return null;
    return notes.slice(match.index + match[0].length).trim();
  };

  const before = body(current);
  const after = body(proposed);

  if (before === null || after === null) return true;
  return before !== after || splitNotes(current).userPart !== splitNotes(proposed).userPart;
}
