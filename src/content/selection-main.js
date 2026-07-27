/**
 * MAIN-world script: leest de selectie uit de TanStack-tabel van ACC.
 *
 * Dit moet in de MAIN world draaien, want de tabelinstantie hangt aan de
 * React-fiber van de pagina en die is vanuit een isolated content script niet
 * te zien. Alles wat hier gebeurt, gebeurt daarom in de paginacontext — en
 * dus zonder toegang tot `chrome.*`. Het praat met `selection.js` via
 * `window.postMessage`.
 *
 * De aanpak is bewezen met `poc/selection-probe` op 27-07-2026: de lijst is een
 * TanStack Table met `getRowId: e => e.uid`, en `getState().rowSelection` heeft
 * de formulier-GUID's als sleutels.
 */
(() => {
  'use strict';

  const CHANNEL = 'acc-form-stamper';

  /** De React-fiber van een element, ongeacht de React-versie. */
  function reactFiberOf(el) {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    return key ? el[key] : null;
  }

  /**
   * Zoekt de tabelinstantie door de fiber-keten omhoog te lopen.
   *
   * Begint bij de `<table>` en bij een paar selectievakjes: welk van de twee het
   * oplevert verschilt per weergave van ACC, en twee ingangen is goedkoper dan
   * uitzoeken welke de juiste is.
   */
  function findTable() {
    const seeds = [
      document.querySelector('table'),
      ...Array.from(document.querySelectorAll('input[type="checkbox"]')).slice(0, 3),
    ].filter(Boolean);

    for (const seed of seeds) {
      let fiber = reactFiberOf(seed);
      let level = 0;
      while (fiber && level < 30) {
        const candidate = fiber.memoizedProps && fiber.memoizedProps.table;
        if (candidate && typeof candidate.getState === 'function') return candidate;
        fiber = fiber.return;
        level += 1;
      }
    }
    return null;
  }

  /**
   * De aangevinkte formulier-id's.
   *
   * Leest de **sleutels van `rowSelection`**, niet `getSelectedRowModel()`. Dat
   * onderscheid is wezenlijk: de tabel houdt maar één pagina van 50 rijen vast,
   * dus het rijmodel vergeet wat er op een andere pagina is aangevinkt. De
   * selectiestaat zelf overleeft het doorbladeren wel — bevestigd met 200
   * formulieren over vier pagina's, waar het rijmodel er 50 zou geven.
   *
   * TanStack laat een sleutel op `false` staan als je hem uitvinkt, dus filteren
   * op waarde is nodig — anders telt een uitgevinkt formulier gewoon mee.
   */
  function getSelection() {
    const table = findTable();
    if (!table) {
      return {
        ok: false,
        error:
          'De formulierenlijst is niet gevonden. Staat deze pagina op het ' +
          'formulieroverzicht van Forma Build?',
      };
    }

    let selection;
    try {
      selection = table.getState().rowSelection || {};
    } catch (error) {
      return { ok: false, error: `De selectie is niet uit te lezen: ${error.message}` };
    }

    const formIds = Object.keys(selection).filter((id) => selection[id]);

    // De volgorde waarin de gebruiker heeft aangevinkt zegt niets; die van de
    // lijst waar hij naar kijkt wel. Neem daarom de weergavevolgorde van de
    // tabel over, inclusief de sortering die de gebruiker zelf heeft gekozen.
    //
    // Dit lukt alleen voor de rijen die de tabel vasthoudt — één pagina van 50.
    // Formulieren van een andere pagina bestaan hier niet en kunnen dus niet
    // gerangschikt worden; die komen erachteraan, in hun onderlinge volgorde.
    let volgorde = [];
    try {
      volgorde = table.getRowModel().rows.map((rij) => rij.id);
    } catch {
      // Zonder rijmodel geen volgorde. Niet fataal: dan blijft het zoals het was.
    }

    const positie = new Map(volgorde.map((id, index) => [id, index]));
    // Niet `Infinity` gebruiken: `Infinity - Infinity` is `NaN` en dan doet
    // `sort` onvoorspelbare dingen. Met een eindig getal blijven gelijke waarden
    // netjes op hun plek staan.
    const plaats = (id) => (positie.has(id) ? positie.get(id) : Number.MAX_SAFE_INTEGER);
    formIds.sort((a, b) => plaats(a) - plaats(b));

    let sortering = [];
    try {
      sortering = table.getState().sorting ?? [];
    } catch {
      // Alleen bedoeld om te kunnen zien waar de tabel op gesorteerd stond.
    }

    return { ok: true, formIds, geordend: positie.size, sortering };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'request') return;

    const payload = data.action === 'getSelection' ? getSelection() : { ok: false, error: `Onbekende actie: ${data.action}` };

    window.postMessage({ channel: CHANNEL, direction: 'response', id: data.id, payload }, '*');
  });
})();
