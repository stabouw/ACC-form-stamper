/**
 * Isolated-world content script: de brug tussen de popup en de pagina.
 *
 * De popup kan niet rechtstreeks bij de React-fiber van ACC, en het MAIN-world
 * script kan niet bij `chrome.*`. Dit script zit er precies tussenin en heeft
 * daarom zelf geen logica: het geeft door.
 *
 * Het leest wél het project uit de adresbalk. Dat is geen logica maar een feit
 * dat hier voor het oprapen ligt en in de popup niet.
 */
(() => {
  'use strict';

  const CHANNEL = 'acc-form-stamper';
  const pending = new Map();
  let nextId = 1;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'response') return;

    const resolve = pending.get(data.id);
    if (resolve) {
      pending.delete(data.id);
      resolve(data.payload);
    }
  });

  /** Stelt het MAIN-world script een vraag, met een tijdslimiet. */
  function ask(action) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      window.postMessage({ channel: CHANNEL, direction: 'request', action, id }, '*');

      // Zonder deze limiet blijft de popup wachten op een script dat er niet is.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({
            ok: false,
            error: 'De pagina reageert niet. Ververs de Forma Build-pagina en probeer opnieuw.',
          });
        }
      }, 5000);
    });
  }

  /**
   * Het project-id uit de adresbalk, zonder `b.`-voorvoegsel.
   *
   * De Forms- en Assets-API willen het zonder; Data Management levert het mét.
   * Hier meteen goed doorgeven scheelt een 404 die op een rechtenprobleem lijkt.
   */
  function projectIdUitUrl() {
    const match = /\/projects\/(b\.)?([0-9a-f-]{36})/i.exec(location.href);
    return match ? match[2] : null;
  }

  // De projectnaam werd hier eerst uit `document.title` gegokt. Dat leverde
  // "Build" op — de naam van de module, niet van het project. Hij komt nu uit de
  // Admin-API, via de service worker.

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'getSelection') return false;

    ask('getSelection').then((payload) => {
      sendResponse({ ...payload, projectId: projectIdUitUrl() });
    });

    // Houdt het kanaal open voor het asynchrone antwoord.
    return true;
  });
})();
