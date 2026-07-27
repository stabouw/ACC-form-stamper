/**
 * Tests voor het journaal, het stempelen per formulier, en het terugdraaien.
 *
 * Draaien met: node --test src/journaal.test.js
 *
 * Dit is de kant die écht schrijft, dus die is het testen waard — maar niet
 * tegen ACC. De service worker wordt geladen met een nagebootste `chrome` en een
 * nagebootste `FormaClient`; wat er getest wordt is de volgorde van de aanroepen
 * en wat er in het journaal belandt.
 *
 * Waarom dat ertoe doet: het journaal is het enige dat terugdraaien mogelijk
 * maakt. Staat er iets verkeerds in, dan is dat pas te merken op het moment dat
 * iemand zijn wijziging terug wil — en dan is het te laat.
 */

import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

// -----------------------------------------------------------------------------
// De browser nabootsen, vóór de service worker geladen wordt
// -----------------------------------------------------------------------------

let opslag = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(sleutel) {
        return sleutel in opslag ? { [sleutel]: opslag[sleutel] } : {};
      },
      async set(waarden) {
        Object.assign(opslag, waarden);
      },
    },
  },
  runtime: { onMessage: { addListener() {} } },
  identity: { getRedirectURL: () => 'https://lcelfplffcnfhajffomdelokagjkggnf.chromiumapp.org/' },
};

const { stamper } = await import('./background.js').then(() => ({ stamper: globalThis.stamper }));

// -----------------------------------------------------------------------------
// De API nabootsen
// -----------------------------------------------------------------------------

const PROJECT = '948dda3b-d141-4f76-a865-809525828bd2';
const TEMPLATE = '7cfd9b15-a418-4ac5-9530-d6fcad4ff2ae';

/** Elke aanroep die de nep-client krijgt, in volgorde. */
let aanroepen = [];
/** De formulieren zoals ze "in ACC" staan. */
let formulieren = {};
/** Formulier-id's waarvoor de eerstvolgende schrijfactie moet mislukken. */
let laatFalen = new Set();

function zetFormulierOp(id, { notes = '', status = 'inProgress', naam = 'Testformulier', formNum = 1 } = {}) {
  formulieren[id] = { id, notes, status, name: naam, formNum, formTemplateId: TEMPLATE };
}

beforeEach(() => {
  opslag = {};
  aanroepen = [];
  formulieren = {};
  laatFalen = new Set();

  stamper.forma.listForms = async ({ ids }) => ({
    forms: (ids ?? []).map((id) => formulieren[id]).filter(Boolean),
    totalResults: 1,
  });

  stamper.forma.listCategories = async () => [
    { id: 'root', name: 'ROOT', parentId: null },
    { id: 'ba', name: 'Bouwkundig', parentId: 'root' },
  ];

  stamper.forma.findAssetIdsForForms = async ({ formIds }) =>
    new Map(formIds.map((id) => [id, ['asset-1']]));

  stamper.forma.getAssetsByIds = async () => [
    { id: 'asset-1', clientAssetId: 'Pomp 3', categoryId: 'ba' },
  ];

  stamper.forma.updateForm = async ({ formId, patch }) => {
    aanroepen.push({ formId, patch });
    if (laatFalen.has(formId)) {
      laatFalen.delete(formId);
      throw new Error('ACC gaf een 500');
    }
    Object.assign(formulieren[formId], patch);
    return formulieren[formId];
  };

  stamper.forma.setFormNotes = ({ projectId, templateId, formId, notes }) =>
    stamper.forma.updateForm({ projectId, templateId, formId, patch: { notes } });
});

const runVan = async (runId) => (await stamper.getJournaal()).runs.find((r) => r.id === runId);

// -----------------------------------------------------------------------------
// Het journaal wordt per formulier weggeschreven
// -----------------------------------------------------------------------------

test('een gestempeld formulier staat meteen in het journaal', async () => {
  zetFormulierOp('f1', { notes: 'Klep vervangen.' });
  const { runId } = await stamper.startRun({ projectId: PROJECT });

  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });

  const run = await runVan(runId);
  assert.equal(run.formulieren.length, 1);
  assert.equal(run.formulieren[0].resultaat, 'geschreven');
});

test('het journaal bewaart wat er stond vlak vóór het schrijven', async () => {
  zetFormulierOp('f1', { notes: 'Klep vervangen.' });
  const { runId } = await stamper.startRun({ projectId: PROJECT });

  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });

  const run = await runVan(runId);
  assert.equal(run.formulieren[0].voor.notes, 'Klep vervangen.');
});

test('een afgebroken uitvoering laat de al gestempelde formulieren terugdraaibaar achter', async () => {
  // Dit is de reden dat het journaal per formulier wordt bijgewerkt en niet aan
  // het eind van de run (design-decisions.md, punt 8).
  zetFormulierOp('f1', { notes: 'een' });
  zetFormulierOp('f2', { notes: 'twee' });
  const { runId } = await stamper.startRun({ projectId: PROJECT });

  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });
  // …en hier stopt de gebruiker, of verloopt het token. Geen afsluitende stap.

  const run = await runVan(runId);
  assert.equal(run.formulieren.length, 1);
  assert.ok(run.formulieren[0].voor, 'zonder terugdraairegel is dit formulier kwijt');
});

// -----------------------------------------------------------------------------
// Opnieuw proberen
// -----------------------------------------------------------------------------

test('een formulier dat na een fout alsnog slaagt, staat één keer in het journaal', async () => {
  zetFormulierOp('f1', { notes: 'Klep vervangen.' });
  laatFalen.add('f1');

  const { runId } = await stamper.startRun({ projectId: PROJECT });
  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });
  assert.equal((await runVan(runId)).formulieren[0].resultaat, 'fout');

  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });

  const run = await runVan(runId);
  assert.equal(run.formulieren.length, 1, 'anders telt het formulier dubbel én wordt het dubbel teruggedraaid');
  assert.equal(run.formulieren[0].resultaat, 'geschreven');
});

// -----------------------------------------------------------------------------
// Gesloten formulieren
// -----------------------------------------------------------------------------

test('een gesloten formulier wordt zonder toestemming niet aangeraakt', async () => {
  zetFormulierOp('f1', { status: 'closed' });
  const { runId } = await stamper.startRun({ projectId: PROJECT });

  const entry = await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });

  assert.equal(entry.resultaat, 'fout');
  assert.equal(aanroepen.length, 0, 'er mag geen enkele schrijfactie gedaan zijn');
});

test('een gesloten formulier gaat open, wordt geschreven, en weer dicht', async () => {
  zetFormulierOp('f1', { status: 'closed' });
  const { runId } = await stamper.startRun({ projectId: PROJECT });

  const entry = await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1', heropenen: true });

  assert.equal(entry.resultaat, 'geschreven');
  assert.equal(entry.heropend, true);
  assert.deepEqual(
    aanroepen.map((a) => a.patch.status ?? 'notities'),
    ['draft', 'notities', 'submitted'],
    'heropenen gaat naar draft, nooit naar in_review',
  );
});

test('blijft een heropend formulier openstaan door een fout, dan staat dat in het journaal', async () => {
  zetFormulierOp('f1', { status: 'closed' });
  const { runId } = await stamper.startRun({ projectId: PROJECT });

  // Het heropenen lukt, het schrijven niet. Het formulier staat nu open terwijl
  // het dicht was — dat mag niet stilletjes gebeuren.
  stamper.forma.setFormNotes = async () => {
    throw new Error('ACC gaf een 500');
  };

  const entry = await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1', heropenen: true });

  assert.equal(entry.resultaat, 'fout');
  assert.equal(entry.formulierBlijftOpen, true);
});

// -----------------------------------------------------------------------------
// Overslaan
// -----------------------------------------------------------------------------

test('een formulier dat al klopt, wordt niet geschreven', async () => {
  zetFormulierOp('f1');
  const { runId } = await stamper.startRun({ projectId: PROJECT });

  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });
  const naEerste = aanroepen.length;

  // Tweede keer: de assetregel is nu gelijk, dus er hoort geen aanroep te komen.
  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });

  assert.equal(aanroepen.length, naEerste, 'geen aanroep, dus ook geen "laatst gewijzigd door"');
  assert.equal((await runVan(runId)).formulieren[0].resultaat, 'overgeslagen');
});

// -----------------------------------------------------------------------------
// Terugdraaien
// -----------------------------------------------------------------------------

test('terugdraaien zet de notities terug', async () => {
  zetFormulierOp('f1', { notes: 'Klep vervangen.' });
  const { runId } = await stamper.startRun({ projectId: PROJECT });
  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });

  assert.notEqual(formulieren.f1.notes, 'Klep vervangen.');

  const uitkomst = await stamper.undoRun({ runId });

  assert.equal(uitkomst.teruggedraaid, 1);
  assert.equal(formulieren.f1.notes, 'Klep vervangen.');
});

test('terugdraaien zet ook de status van een heropend formulier terug', async () => {
  zetFormulierOp('f1', { status: 'closed' });
  const { runId } = await stamper.startRun({ projectId: PROJECT });
  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1', heropenen: true });

  assert.equal(formulieren.f1.status, 'submitted');

  aanroepen = [];
  await stamper.undoRun({ runId });

  assert.deepEqual(
    aanroepen.map((a) => a.patch.status ?? 'notities'),
    ['draft', 'notities', 'submitted'],
  );
});

test('overgeslagen formulieren worden niet teruggedraaid', async () => {
  zetFormulierOp('f1');
  const { runId } = await stamper.startRun({ projectId: PROJECT });
  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });
  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });

  aanroepen = [];
  const uitkomst = await stamper.undoRun({ runId });

  // De tweede aanroep maakte er "overgeslagen" van, maar de eerste schreef wel.
  // Wat geschreven is, moet terug; meer niet.
  assert.equal(uitkomst.teruggedraaid, 0);
  assert.equal(aanroepen.length, 0);
});

test('een half mislukte terugdraaiactie heet niet teruggedraaid', async () => {
  zetFormulierOp('f1', { notes: 'een' });
  zetFormulierOp('f2', { notes: 'twee' });
  const { runId } = await stamper.startRun({ projectId: PROJECT });
  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f1' });
  await stamper.stampForm({ runId, projectId: PROJECT, formId: 'f2' });

  laatFalen.add('f2');
  const uitkomst = await stamper.undoRun({ runId });

  assert.equal(uitkomst.teruggedraaid, 1);
  assert.equal(uitkomst.mislukt.length, 1);
  assert.equal(
    (await runVan(runId)).teruggedraaid,
    false,
    'anders verdwijnt de knop terwijl er nog een formulier op de nieuwe tekst staat',
  );
});

// -----------------------------------------------------------------------------
// Opruimen
// -----------------------------------------------------------------------------

test('een uitvoering waarin niets gebeurde, verdringt geen echte uitvoering', async () => {
  zetFormulierOp('f1', { notes: 'Klep vervangen.' });

  const { runId: echte } = await stamper.startRun({ projectId: PROJECT });
  await stamper.stampForm({ runId: echte, projectId: PROJECT, formId: 'f1' });

  // Drie keer openen en meteen weglopen.
  await stamper.startRun({ projectId: PROJECT });
  await stamper.startRun({ projectId: PROJECT });
  const { runId: laatste } = await stamper.startRun({ projectId: PROJECT });

  const runs = (await stamper.getJournaal()).runs;
  assert.equal(runs.length, 2, 'alleen de lege van nu en de echte van daarnet');
  assert.deepEqual(runs.map((r) => r.id), [laatste, echte]);
});
