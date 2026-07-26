/**
 * Isolated-world content script.
 *
 * Owns the on-page panel and relays questions to the MAIN-world probe. It
 * deliberately holds no logic of its own: everything it reports comes back
 * from probe-main.js.
 */
(() => {
  'use strict';

  const CHANNEL = 'acc-form-stamper-probe';
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

  function ask(action) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      window.postMessage({ channel: CHANNEL, direction: 'request', action, id }, '*');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ error: 'probe reageerde niet — draait probe-main.js wel? (MAIN world)' });
        }
      }, 5000);
    });
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  const panel = document.createElement('div');
  panel.id = 'acc-probe-panel';
  panel.innerHTML = `
    <div class="acc-probe-head">
      <span>Selectie probe</span>
      <button type="button" data-act="toggle" title="In-/uitklappen">–</button>
    </div>
    <div class="acc-probe-body">
      <p class="acc-probe-hint">
        Selecteer eerst een paar formulieren in de lijst, klik dan op <em>Probe selectie</em>.
      </p>
      <div class="acc-probe-actions">
        <button type="button" data-act="table">Probe tabel</button>
        <button type="button" data-act="selection">Probe selectie</button>
        <button type="button" data-act="network">Netwerk log</button>
        <button type="button" data-act="copy">Kopieer</button>
      </div>
      <textarea class="acc-probe-out" readonly placeholder="Rapport verschijnt hier…"></textarea>
    </div>
  `;

  const out = panel.querySelector('.acc-probe-out');

  function show(title, payload) {
    out.value = `=== ${title} — ${new Date().toISOString()} ===\n\n${JSON.stringify(payload, null, 2)}`;
  }

  panel.addEventListener('click', async (event) => {
    const act = event.target instanceof HTMLElement ? event.target.dataset.act : null;
    if (!act) return;

    if (act === 'toggle') {
      panel.classList.toggle('collapsed');
      event.target.textContent = panel.classList.contains('collapsed') ? '+' : '–';
      return;
    }

    if (act === 'copy') {
      out.select();
      try {
        await navigator.clipboard.writeText(out.value);
        event.target.textContent = 'Gekopieerd';
        setTimeout(() => {
          event.target.textContent = 'Kopieer';
        }, 1500);
      } catch {
        document.execCommand('copy');
      }
      return;
    }

    if (act === 'table') {
      show('TABEL', await ask('probeTable'));
      return;
    }

    if (act === 'selection') {
      show('SELECTIE', await ask('probeSelection'));
      return;
    }

    if (act === 'network') {
      show('NETWERK', await ask('getRequests'));
    }
  });

  function mount() {
    if (!document.body || document.getElementById('acc-probe-panel')) return;
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
