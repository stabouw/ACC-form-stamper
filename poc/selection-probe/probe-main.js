/**
 * MAIN-world probe.
 *
 * Runs inside the page's own JS context (not the extension's isolated world),
 * which is required for two things the isolated world cannot do:
 *   1. Hook window.fetch / XMLHttpRequest before the SPA boots, to see which
 *      API calls the Forms list actually makes and what shape they return.
 *   2. Read React's expando properties (__reactFiber$… / __reactProps$…) off
 *      DOM nodes, which is where the row's underlying data object — including
 *      the real form id — usually lives.
 *
 * It never sends anything anywhere. It answers questions asked over
 * window.postMessage by the content script, and values are redacted by
 * default so the report describes shapes rather than project data.
 */
(() => {
  'use strict';

  const CHANNEL = 'acc-form-stamper-probe';
  const MAX_REQUESTS = 400;
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Ring buffer of observed API calls. */
  const requests = [];

  function record(entry) {
    requests.push(entry);
    if (requests.length > MAX_REQUESTS) requests.shift();
  }

  function isInteresting(url) {
    try {
      const { hostname } = new URL(url, location.href);
      return /autodesk\.(com|eu|io)$/.test(hostname);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Value summarising / redaction
  // ---------------------------------------------------------------------------

  /**
   * Describes a value's shape without reproducing its content. GUIDs are called
   * out explicitly because that is what we are hunting for: a response or a prop
   * tree containing GUIDs is a candidate source of form ids.
   */
  function summarize(value, depth = 0, maxDepth = 4) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    const t = typeof value;

    if (t === 'string') {
      if (GUID_RE.test(value)) return 'GUID';
      if (value.length <= 24) return `string("${value}")`; // short strings are usually keys/enums, not data
      return `string(len=${value.length})`;
    }
    if (t === 'number' || t === 'boolean') return `${t}(${value})`;
    if (t === 'function') return 'function';
    if (t !== 'object') return t;

    if (depth >= maxDepth) return Array.isArray(value) ? `array(${value.length}, …)` : 'object{…}';

    if (Array.isArray(value)) {
      if (value.length === 0) return 'array(0)';
      return {
        __array: value.length,
        first: summarize(value[0], depth + 1, maxDepth),
      };
    }

    const out = {};
    for (const key of Object.keys(value).slice(0, 40)) {
      let v;
      try {
        v = value[key];
      } catch {
        continue; // getters can throw
      }
      out[key] = summarize(v, depth + 1, maxDepth);
    }
    return out;
  }

  /**
   * Walks an object graph collecting the paths at which GUID-valued strings sit.
   * This is the payload that tells us how to reach a form id from a row element.
   */
  function findGuidPaths(root, { maxDepth = 6, maxPaths = 60 } = {}) {
    const hits = [];
    const seen = new WeakSet();

    (function walk(node, path, depth) {
      if (hits.length >= maxPaths || depth > maxDepth || node === null || node === undefined) return;

      if (typeof node === 'string') {
        if (GUID_RE.test(node)) hits.push({ path, value: node });
        return;
      }
      if (typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);

      // Skip DOM nodes and React fibers themselves — they are cyclic and huge.
      if (node instanceof Node) return;

      const keys = Array.isArray(node)
        ? node.slice(0, 20).map((_, i) => i)
        : Object.keys(node).slice(0, 40);

      for (const key of keys) {
        if (typeof key === 'string' && (key.startsWith('__react') || key === 'stateNode' || key === 'return')) continue;
        let child;
        try {
          child = node[key];
        } catch {
          continue;
        }
        walk(child, Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`, depth + 1);
      }
    })(root, '', 0);

    return hits;
  }

  // ---------------------------------------------------------------------------
  // Network interception
  // ---------------------------------------------------------------------------

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const req = args[0];
      const url = typeof req === 'string' ? req : req && req.url;
      const method = (args[1] && args[1].method) || (req && req.method) || 'GET';

      const promise = originalFetch.apply(this, args);

      if (url && isInteresting(url)) {
        promise
          .then((res) => {
            const clone = res.clone();
            const contentType = clone.headers.get('content-type') || '';
            if (!contentType.includes('json')) {
              record({ kind: 'fetch', method, url, status: res.status, contentType, body: '(non-json)' });
              return;
            }
            clone
              .json()
              .then((json) => {
                record({
                  kind: 'fetch',
                  method,
                  url,
                  status: res.status,
                  contentType,
                  body: summarize(json),
                  guidCount: findGuidPaths(json, { maxPaths: 200 }).length,
                });
              })
              .catch(() => {
                record({ kind: 'fetch', method, url, status: res.status, contentType, body: '(unparseable)' });
              });
          })
          .catch(() => {
            record({ kind: 'fetch', method, url, status: 'network-error' });
          });
      }

      return promise;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__probe = { method, url };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const meta = this.__probe;
    if (meta && isInteresting(meta.url)) {
      this.addEventListener('load', () => {
        let body = '(not json)';
        let guidCount = 0;
        try {
          const contentType = this.getResponseHeader('content-type') || '';
          if (contentType.includes('json') && typeof this.responseText === 'string') {
            const json = JSON.parse(this.responseText);
            body = summarize(json);
            guidCount = findGuidPaths(json, { maxPaths: 200 }).length;
          }
        } catch {
          body = '(unparseable)';
        }
        record({ kind: 'xhr', method: meta.method, url: meta.url, status: this.status, body, guidCount });
      });
    }
    return originalSend.apply(this, args);
  };

  // ---------------------------------------------------------------------------
  // Selection probing
  // ---------------------------------------------------------------------------

  function reactKeys(el) {
    return Object.keys(el).filter((k) => k.startsWith('__react'));
  }

  function reactPropsOf(el) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
    return key ? el[key] : null;
  }

  function reactFiberOf(el) {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    return key ? el[key] : null;
  }

  function describeElement(el) {
    const attrs = {};
    for (const attr of Array.from(el.attributes || [])) {
      attrs[attr.name] = attr.name === 'class' ? `(${attr.value.split(/\s+/).length} classes)` : attr.value;
    }
    return {
      tag: el.tagName.toLowerCase(),
      attrs,
      reactKeys: reactKeys(el),
    };
  }

  /**
   * For a candidate row element, climbs the React fiber chain looking for props
   * that contain GUIDs. The path reported here is what the real extension would
   * later read to get a form id.
   */
  function probeFiber(el, levels = 12) {
    const out = [];

    const props = reactPropsOf(el);
    if (props) {
      const hits = findGuidPaths(props);
      if (hits.length) out.push({ source: '__reactProps$ (element)', hits: hits.slice(0, 10) });
    }

    let fiber = reactFiberOf(el);
    let level = 0;
    while (fiber && level < levels) {
      const memo = fiber.memoizedProps;
      if (memo) {
        const hits = findGuidPaths(memo);
        if (hits.length) {
          out.push({
            source: `fiber.return^${level}.memoizedProps`,
            component:
              (fiber.type && (fiber.type.displayName || fiber.type.name)) ||
              (typeof fiber.type === 'string' ? fiber.type : '(anon)'),
            hits: hits.slice(0, 10),
          });
        }
      }
      fiber = fiber.return;
      level += 1;
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // TanStack Table instance
  // ---------------------------------------------------------------------------

  /**
   * The Forms list is a TanStack Table. Its instance carries the selection state
   * and the underlying row objects, which is a far more stable place to read
   * from than checkbox markup or row ordering. Walk the fiber chain from the
   * table (or a checkbox) looking for props holding an object with getState().
   */
  function findTanstackTable() {
    const seeds = [
      document.querySelector('table'),
      ...Array.from(document.querySelectorAll('input[type="checkbox"]')).slice(0, 3),
    ].filter(Boolean);

    for (const seed of seeds) {
      let fiber = reactFiberOf(seed);
      let level = 0;
      while (fiber && level < 30) {
        const props = fiber.memoizedProps;
        const candidate = props && props.table;
        if (candidate && typeof candidate.getState === 'function') {
          return { table: candidate, level, seed: seed.tagName.toLowerCase() };
        }
        fiber = fiber.return;
        level += 1;
      }
    }
    return null;
  }

  function probeTable() {
    const found = findTanstackTable();
    if (!found) {
      return { error: 'geen TanStack table-instantie gevonden vanaf <table> of een checkbox' };
    }

    const { table } = found;
    const out = { foundVia: found.seed, fiberLevel: found.level };

    out.tableMethods = Object.keys(table)
      .filter((k) => typeof table[k] === 'function')
      .sort();

    try {
      out.state = summarize(table.getState(), 0, 3);
    } catch (err) {
      out.stateError = String(err && err.message);
    }

    // Raw, not summarised: the keys are what tell us whether selection is keyed
    // by form uid or by row index.
    try {
      out.rowSelectionRaw = table.getState().rowSelection;
    } catch (err) {
      out.rowSelectionError = String(err && err.message);
    }

    try {
      const rows = table.getSelectedRowModel().rows;
      out.selectedRows = {
        count: rows.length,
        samples: rows.slice(0, 5).map((r) => ({
          id: r.id,
          index: r.index,
          original: summarize(r.original, 0, 2),
        })),
      };
    } catch (err) {
      out.selectedRowsError = String(err && err.message);
    }

    try {
      const data = table.options.data || [];
      out.data = { length: data.length, firstRow: summarize(data[0], 0, 3) };
      out.getRowId =
        typeof table.options.getRowId === 'function'
          ? String(table.options.getRowId).slice(0, 300)
          : '(niet gezet — rij-id is dan de index)';
    } catch (err) {
      out.dataError = String(err && err.message);
    }

    try {
      out.visibleRowCount = table.getRowModel().rows.length;
    } catch {
      /* optional */
    }

    return out;
  }

  /**
   * Finds elements that look like a selected row, using several independent
   * strategies so we learn which one ACC actually uses.
   */
  function probeSelection() {
    const strategies = {};

    const allChecked = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter((i) => i.checked);

    // The select-all box in the header reports checked with aria-checked="mixed"
    // (or "true" when everything is selected), so it has to be excluded before
    // the count means anything. Row boxes live outside <thead>.
    const checked = allChecked.filter(
      (i) => i.getAttribute('aria-checked') !== 'mixed' && !i.closest('thead'),
    );

    strategies.checkedCheckboxes = {
      countIncludingHeader: allChecked.length,
      countRowsOnly: checked.length,
      samples: checked.slice(0, 3).map(describeElement),
    };

    const ariaSelected = Array.from(document.querySelectorAll('[aria-selected="true"]'));
    strategies.ariaSelected = {
      count: ariaSelected.length,
      samples: ariaSelected.slice(0, 3).map(describeElement),
    };

    const ariaChecked = Array.from(document.querySelectorAll('[aria-checked="true"]'));
    strategies.ariaChecked = {
      count: ariaChecked.length,
      samples: ariaChecked.slice(0, 3).map(describeElement),
    };

    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    strategies.roleRows = {
      count: rows.length,
      sample: rows.length ? describeElement(rows[1] || rows[0]) : null,
    };

    // React inspection on the most promising candidates: the ancestors of a
    // ticked checkbox, and any aria-selected row.
    const candidates = [];
    for (const input of checked.slice(0, 3)) {
      let el = input;
      for (let i = 0; i < 8 && el; i += 1) {
        candidates.push({ label: `checkbox ancestor ^${i}`, el });
        el = el.parentElement;
      }
    }
    for (const el of ariaSelected.slice(0, 2)) {
      candidates.push({ label: 'aria-selected element', el });
    }

    const reactFindings = [];
    for (const { label, el } of candidates) {
      let findings;
      try {
        findings = probeFiber(el);
      } catch (err) {
        findings = [{ error: String(err && err.message) }];
      }
      if (findings.length) {
        reactFindings.push({ label, tag: el.tagName.toLowerCase(), findings });
      }
      if (reactFindings.length >= 6) break;
    }
    strategies.reactFiber = reactFindings;

    // Anything in the URL or session storage that looks like a selection.
    strategies.location = { href: location.href.replace(/[0-9a-f-]{36}/gi, '<GUID>') };

    return strategies;
  }

  // ---------------------------------------------------------------------------
  // Message plumbing
  // ---------------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'request') return;

    let payload;
    try {
      if (data.action === 'probeSelection') {
        payload = probeSelection();
      } else if (data.action === 'probeTable') {
        payload = probeTable();
      } else if (data.action === 'getRequests') {
        payload = requests.map((r) => ({
          ...r,
          url: r.url.replace(/[0-9a-f-]{36}/gi, '<GUID>'),
        }));
      } else {
        payload = { error: `unknown action: ${data.action}` };
      }
    } catch (err) {
      payload = { error: String((err && err.stack) || err) };
    }

    window.postMessage({ channel: CHANNEL, direction: 'response', id: data.id, payload }, '*');
  });

  window.postMessage({ channel: CHANNEL, direction: 'ready' }, '*');
})();
