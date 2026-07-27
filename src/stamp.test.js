/**
 * Tests voor de stempellogica.
 *
 * Draaien met: node --test src/
 *
 * De nadruk ligt op `bepaalUitkomst`, want dat is wat het Selecteren-scherm
 * toont en dus wat de gebruiker te zien krijgt vóór er geschreven wordt. Zit
 * daar een fout in, dan klopt het voorbeeld niet met wat er gebeurt — en dat is
 * de enige belofte die deze tool doet.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NOTES_MAX_LENGTH,
  bepaalUitkomst,
  buildCategoryIndex,
  buildStampedNotes,
  formatAsset,
  splitNotes,
  stampChanged,
  tekstOnderBlok,
} from './stamp.js';

/** Vaste datum, anders verandert de markeringsregel per dag dat je test. */
const DATUM = new Date(2026, 6, 26);

const categorieën = [
  { id: 'root', name: 'ROOT', parentId: null },
  { id: 'ba', name: 'Bouwkundig', parentId: 'root' },
  { id: 'ba24', name: 'Pompen', parentId: 'ba' },
];
const index = buildCategoryIndex(categorieën);

const asset = (clientAssetId, categoryId = 'ba24') => ({ id: `id-${clientAssetId}`, clientAssetId, categoryId });

/** Bouwt notities en de bijbehorende uitkomst in één stap, zoals previewForms doet. */
function uitkomstVoor({ huidig = '', assets = [] }) {
  const { notes, shown, total, fits } = buildStampedNotes({
    existing: huidig,
    assets,
    categoryIndex: index,
    date: DATUM,
  });
  return {
    voorstel: notes,
    ...bepaalUitkomst({ huidig, voorstel: notes, assetCount: assets.length, fits, shown, total }),
  };
}

// -----------------------------------------------------------------------------
// De wortelcategorie
// -----------------------------------------------------------------------------

test('de onzichtbare wortelcategorie staat niet in het pad', () => {
  assert.equal(formatAsset(asset('Pomp 3'), index), 'Pomp 3 (Bouwkundig > Pompen)');
});

// -----------------------------------------------------------------------------
// De vier tags
// -----------------------------------------------------------------------------

test('een formulier zonder stempel krijgt "nieuw"', () => {
  const u = uitkomstVoor({ huidig: 'Klep vervangen.', assets: [asset('Pomp 3')] });
  assert.equal(u.tag, 'nieuw');
  assert.equal(u.hadStempel, false);
});

test('een formulier met een verouderde assetregel krijgt "bijgewerkt"', () => {
  const oud = uitkomstVoor({ assets: [asset('Pomp 3')] }).voorstel;
  const u = uitkomstVoor({ huidig: oud, assets: [asset('Pomp 3'), asset('Pomp 4')] });
  assert.equal(u.tag, 'bijgewerkt');
  assert.equal(u.hadStempel, true);
});

test('dezelfde assets leveren "ongewijzigd" op', () => {
  const oud = uitkomstVoor({ assets: [asset('Pomp 3')] }).voorstel;
  const u = uitkomstVoor({ huidig: oud, assets: [asset('Pomp 3')] });
  assert.equal(u.tag, 'ongewijzigd');
});

test('een oudere datum in de markering maakt een formulier niet verouderd', () => {
  // Anders schrijft de tool bij elke run alles opnieuw — de reden dat
  // stampChanged op de assetregel vergelijkt en niet op de hele tekst.
  const gisteren = buildStampedNotes({
    assets: [asset('Pomp 3')],
    categoryIndex: index,
    date: new Date(2026, 0, 1),
  }).notes;

  const u = uitkomstVoor({ huidig: gisteren, assets: [asset('Pomp 3')] });
  assert.equal(u.tag, 'ongewijzigd');
});

// -----------------------------------------------------------------------------
// Punt 4: geen assets is niet hetzelfde als niets te doen
// -----------------------------------------------------------------------------

test('geen assets en geen eerdere assetregel is werkelijk niets te doen', () => {
  const u = uitkomstVoor({ huidig: 'Alleen handwerk.', assets: [] });
  assert.equal(u.tag, 'ongewijzigd');
  assert.equal(u.geenAssets, true);
  assert.equal(u.assetregelVervalt, false);
});

test('geen assets mét een eerdere assetregel moet die regel juist leegmaken', () => {
  const oud = uitkomstVoor({ huidig: 'Klep vervangen.', assets: [asset('Pomp 3')] }).voorstel;
  const u = uitkomstVoor({ huidig: oud, assets: [] });

  assert.equal(u.tag, 'bijgewerkt', 'dit is nadrukkelijk geen overslaan');
  assert.equal(u.assetregelVervalt, true);
});

test('de tekst van de gebruiker blijft staan als de assetregel leeggemaakt wordt', () => {
  const oud = uitkomstVoor({ huidig: 'Klep vervangen.', assets: [asset('Pomp 3')] }).voorstel;
  const u = uitkomstVoor({ huidig: oud, assets: [] });

  assert.ok(u.voorstel.startsWith('Klep vervangen.'));
  assert.equal(splitNotes(u.voorstel).userPart, 'Klep vervangen.');
});

// -----------------------------------------------------------------------------
// Punt 5: ingekort en past-niet zijn twee verschillende dingen
// -----------------------------------------------------------------------------

test('een lijst die ingekort moet worden, wordt geschreven en heet niet "past niet"', () => {
  const veel = Array.from({ length: 400 }, (_, i) => asset(`Asset met een tamelijk lange naam ${i}`));
  const u = uitkomstVoor({ assets: veel });

  assert.notEqual(u.tag, 'past-niet');
  assert.equal(u.ingekort, true);
  assert.ok(u.getoond < u.totaal);
  assert.ok(u.voorstel.length <= NOTES_MAX_LENGTH);
});

test('een gebruikerstekst die de 8000 al vult, levert "past niet" op', () => {
  const u = uitkomstVoor({ huidig: 'x'.repeat(NOTES_MAX_LENGTH - 10), assets: [asset('Pomp 3')] });

  assert.equal(u.tag, 'past-niet', 'er kan niets geschreven worden, dus geen "bijgewerkt"');
  assert.equal(u.ingekort, false, '"ingekort" zou suggereren dat er wél iets geschreven wordt');
});

test('een passende lijst is niet ingekort', () => {
  const u = uitkomstVoor({ assets: [asset('Pomp 3'), asset('Pomp 4')] });
  assert.equal(u.ingekort, false);
  assert.equal(u.getoond, u.totaal);
});

// -----------------------------------------------------------------------------
// notes kan null zijn — gemeten bij PDF-formulieren
// -----------------------------------------------------------------------------

test('lege notities zijn stabiel, of ze nu "" of null waren', () => {
  // previewForms doet `form.notes ?? ''`; dit legt vast dat beide vormen tot
  // dezelfde uitkomst leiden, want anders krijgt één sjabloontype een andere tag.
  const vanuitLeeg = uitkomstVoor({ huidig: '', assets: [asset('Pomp 3')] });
  const vanuitNull = uitkomstVoor({ huidig: null ?? '', assets: [asset('Pomp 3')] });

  assert.equal(vanuitLeeg.tag, vanuitNull.tag);
  assert.equal(vanuitLeeg.voorstel, vanuitNull.voorstel);
});

// -----------------------------------------------------------------------------
// Punt 6: tekst onder het blok gaat verloren
// -----------------------------------------------------------------------------

test('zonder markering is er niets onder het blok', () => {
  assert.equal(tekstOnderBlok('Gewoon een notitie.'), '');
});

test('alleen een assetregel onder de markering telt niet als verloren tekst', () => {
  const gestempeld = uitkomstVoor({ huidig: 'Klep vervangen.', assets: [asset('Pomp 3')] }).voorstel;
  assert.equal(tekstOnderBlok(gestempeld), '');
});

test('tekst die iemand ónder het blok typte, wordt herkend', () => {
  const gestempeld = uitkomstVoor({ huidig: 'Klep vervangen.', assets: [asset('Pomp 3')] }).voorstel;
  const metNotitie = `${gestempeld}\nNog nabellen over de klep.`;

  assert.equal(tekstOnderBlok(metNotitie), 'Nog nabellen over de klep.');
});

test('meerdere regels onder het blok komen compleet terug', () => {
  const gestempeld = uitkomstVoor({ assets: [asset('Pomp 3')] }).voorstel;
  const metNotitie = `${gestempeld}\nregel een\nregel twee`;

  assert.equal(tekstOnderBlok(metNotitie), 'regel een\nregel twee');
});

test('tekst boven de markering telt niet mee — die blijft juist staan', () => {
  const gestempeld = uitkomstVoor({ huidig: 'Blijft staan.', assets: [asset('Pomp 3')] }).voorstel;

  assert.equal(tekstOnderBlok(gestempeld), '');
  assert.equal(splitNotes(gestempeld).userPart, 'Blijft staan.');
});

// -----------------------------------------------------------------------------
// Volgorde
// -----------------------------------------------------------------------------

test('dezelfde assets in een andere volgorde leveren dezelfde tekst op', () => {
  // Zonder vaste volgorde lijkt elke tweede run gewijzigd en schrijft de tool
  // alles opnieuw.
  const a = uitkomstVoor({ assets: [asset('Bravo'), asset('Alfa')] });
  const b = uitkomstVoor({ assets: [asset('Alfa'), asset('Bravo')] });

  assert.equal(a.voorstel, b.voorstel);
  assert.equal(stampChanged(a.voorstel, b.voorstel), false);
});
