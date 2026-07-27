/**
 * REST client for the ACC/Forma endpoints this tool uses.
 *
 * Covers four services that do not agree with each other on much:
 *
 *   Forms         reading on v2, writing on v1 — there is no v2 PATCH
 *   Relationships bim360 host, its own container id, needs x-ads-region
 *   Assets        v2
 *   Categories    v1
 *
 * The mismatches are real and documented in docs/api-notes.md; they are not
 * something to tidy up here. This class hides them behind one surface so the
 * rest of the extension never has to remember which call is which.
 */

import { ApsError, describeStatus } from './errors.js';

const HOST = 'https://developer.api.autodesk.com';

/** Relationship domains, both proven in production by BatchFormCreator. */
export const FORM_DOMAIN = 'autodesk-construction-form';
export const FORM_TYPE = 'form';
export const ASSET_DOMAIN = 'autodesk-bim360-asset';
export const ASSET_TYPE = 'asset';

/** `entities` on relationships:intersect is capped at 20 by the API. */
export const INTERSECT_MAX_ENTITIES = 20;

/** Documented Max length on the notes field. */
export const NOTES_MAX_LENGTH = 8000;

/**
 * `limit` on GET forms v2 accepts 1..50. Asking for more is a 400, not a
 * clamped response — and the error says nothing about the limit, so it is
 * worth enforcing here.
 */
export const FORMS_MAX_LIMIT = 50;

/**
 * Form status values differ between the versions we call: v2 reads, v1 writes.
 * Translate at the edge and keep v1 internally — that is what a rollback has
 * to be able to write back.
 */
export const STATUS_V1_TO_V2 = Object.freeze({
  draft: 'inProgress',
  in_review: 'inReview',
  submitted: 'closed',
  discarded: 'discarded',
  archived: 'archived',
});

export const STATUS_V2_TO_V1 = Object.freeze(
  Object.fromEntries(Object.entries(STATUS_V1_TO_V2).map(([v1, v2]) => [v2, v1])),
);

/** Statuses in which a form accepts edits at all (v1 vocabulary). */
const EDITABLE_V1_STATUSES = new Set(['draft', 'in_review']);

/**
 * The Forms and Assets APIs want the project id without the `b.` prefix that
 * Data Management hands out. Passing the prefixed one through gives a 404 that
 * looks like a permissions problem, so normalise everywhere.
 *
 * @param {string} projectId
 */
export function normalizeProjectId(projectId) {
  if (!projectId) throw new Error('projectId is verplicht');
  return projectId.startsWith('b.') ? projectId.slice(2) : projectId;
}

/** @param {string} status v1 status value */
export function isEditableStatus(status) {
  return EDITABLE_V1_STATUSES.has(status);
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -----------------------------------------------------------------------------
// FormaClient
// -----------------------------------------------------------------------------

export class FormaClient {
  /**
   * @param {object} options
   * @param {import('./auth.js').ApsAuth} options.auth
   * @param {'US'|'EMEA'} [options.region]  EMEA for acc.autodesk.eu tenants.
   * @param {number} [options.maxRetries]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({ auth, region = 'EMEA', maxRetries = 3, fetchImpl } = {}) {
    if (!auth) throw new Error('FormaClient: auth is verplicht');
    this.auth = auth;
    this.region = region;
    this.maxRetries = maxRetries;
    this.fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // ---------------------------------------------------------------------------
  // Forms — reading is v2
  // ---------------------------------------------------------------------------

  /**
   * One page of forms.
   *
   * Note `statuses` takes v2 values (`inProgress`, not `draft`); this method
   * translates for you if you pass v1 ones.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {number} [params.limit]   Capped at 50 by the API.
   * @param {number} [params.offset]
   * @param {string[]} [params.ids]   Specific form ids — far cheaper than paging.
   * @param {string[]} [params.statuses]
   * @param {string} [params.sort]
   * @param {string} [params.search]
   * @param {string} [params.templateId]
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{forms: object[], totalResults: number}>}
   */
  async listForms({
    projectId,
    limit = FORMS_MAX_LIMIT,
    offset = 0,
    ids,
    statuses,
    sort,
    search,
    templateId,
    signal,
  } = {}) {
    const query = new URLSearchParams({
      limit: String(Math.min(limit, FORMS_MAX_LIMIT)),
      offset: String(offset),
    });
    if (sort) query.set('sort', sort);
    if (search) query.set('search', search);
    if (templateId) query.set('templateId', templateId);
    for (const id of ids ?? []) query.append('ids', id);
    if (statuses?.length) {
      query.set('statuses', statuses.map((s) => STATUS_V1_TO_V2[s] ?? s).join(','));
    }

    const body = await this._request(
      'GET',
      `${HOST}/construction/forms/v2/projects/${normalizeProjectId(projectId)}/forms?${query}`,
      { signal, context: 'het ophalen van de formulieren' },
    );

    return {
      forms: body.data ?? body.results ?? [],
      totalResults: body.pagination?.totalResults ?? 0,
    };
  }

  /**
   * The project's own record, for its name.
   *
   * Purely cosmetic — the panel shows the name so the user can see which project
   * they are about to stamp. Reading it off the ACC page is not an option: the
   * header markup is not ours and changes without notice.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{id: string, name: string}>}
   */
  async getProject({ projectId, signal } = {}) {
    return this._request(
      'GET',
      `${HOST}/construction/admin/v1/projects/${normalizeProjectId(projectId)}`,
      // De Admin-API routeert per regio. Zonder deze header zoekt hij het project
      // op de US-tenant en meldt hij netjes dat het niet bestaat — een 404 die op
      // een rechtenprobleem lijkt terwijl het een adresprobleem is.
      { region: true, signal, context: 'het ophalen van de projectnaam' },
    );
  }

  /**
   * Every form matching the filter, paging until exhausted.
   *
   * @param {object} params  Same as listForms, minus offset.
   * @returns {AsyncGenerator<object>}
   */
  async *iterateForms({ projectId, limit = FORMS_MAX_LIMIT, ...rest } = {}) {
    let offset = 0;
    for (;;) {
      const { forms, totalResults } = await this.listForms({ projectId, limit, offset, ...rest });
      for (const form of forms) yield form;

      offset += forms.length;
      if (forms.length === 0 || offset >= totalResults) return;
    }
  }

  // ---------------------------------------------------------------------------
  // Forms — writing is v1
  // ---------------------------------------------------------------------------

  /**
   * Updates a form's details.
   *
   * `templateId` is part of the path, so the form's template id has to be
   * carried over from the listing — a form id on its own is not enough to
   * write. In v2 that field is `formTemplateId`.
   *
   * The reference claims PDF forms cannot be updated. Measured on 27-07-2026:
   * they can. Do not filter them out — see docs/api-notes.md.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.templateId
   * @param {string} params.formId
   * @param {object} params.patch  Any of: notes, description, name, status,
   *   assigneeId, assigneeType, formDate, locationId.
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>} The updated form.
   */
  async updateForm({ projectId, templateId, formId, patch, signal } = {}) {
    if (!templateId) throw new Error('updateForm: templateId is verplicht');
    if (!formId) throw new Error('updateForm: formId is verplicht');

    if (typeof patch?.notes === 'string' && patch.notes.length > NOTES_MAX_LENGTH) {
      throw new ApsError(
        'client',
        `De notities zijn te lang (${patch.notes.length} van maximaal ${NOTES_MAX_LENGTH} tekens).`,
      );
    }

    const url =
      `${HOST}/construction/forms/v1/projects/${normalizeProjectId(projectId)}` +
      `/form-templates/${templateId}/forms/${formId}`;

    return this._request('PATCH', url, {
      body: patch,
      signal,
      context: 'het bijwerken van het formulier',
    });
  }

  /**
   * Convenience for the one write this tool actually does.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.templateId
   * @param {string} params.formId
   * @param {string} params.notes
   * @param {AbortSignal} [params.signal]
   */
  async setFormNotes({ projectId, templateId, formId, notes, signal }) {
    return this.updateForm({ projectId, templateId, formId, patch: { notes }, signal });
  }

  // ---------------------------------------------------------------------------
  // Relationships
  // ---------------------------------------------------------------------------

  /**
   * Relationships matching a search, page by page.
   *
   * Relationships are bi-directional and the parameters are symmetric, so this
   * works just as well from the form side as from the asset side.
   *
   * @param {object} params
   * @param {string} params.containerId  Not the same id as projectId.
   * @param {string} [params.domain]
   * @param {string} [params.type]
   * @param {string} [params.id]
   * @param {string} [params.withDomain]
   * @param {string} [params.withType]
   * @param {string} [params.withId]
   * @param {number} [params.pageLimit]
   * @param {AbortSignal} [params.signal]
   * @returns {AsyncGenerator<object>}
   */
  async *searchRelationships({ containerId, pageLimit = 100, signal, ...filters } = {}) {
    let continuationToken;

    for (;;) {
      const query = new URLSearchParams({ pageLimit: String(pageLimit) });
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) query.set(key, String(value));
      }
      if (continuationToken) query.set('continuationToken', continuationToken);

      const body = await this._request(
        'GET',
        `${HOST}/bim360/relationship/v2/containers/${containerId}/relationships:search?${query}`,
        { signal, region: true, context: 'het zoeken naar gekoppelde assets' },
      );

      for (const relationship of body.relationships ?? []) yield relationship;

      continuationToken = body.page?.continuationToken;
      if (!continuationToken) return;
    }
  }

  /**
   * Relationships for a known set of entities.
   *
   * This is the one to use for a selection: it takes a batch rather than one
   * entity per call. Chunking to the API's limit of 20 is handled here.
   *
   * @param {object} params
   * @param {string} params.containerId
   * @param {Array<{domain: string, type: string, id: string}>} params.entities
   * @param {Array<{domain: string, type?: string, id?: string}>} [params.withEntities]
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object[]>} All relationships, across every chunk.
   */
  async intersectRelationships({ containerId, entities, withEntities, signal } = {}) {
    const all = [];

    for (const group of chunk(entities, INTERSECT_MAX_ENTITIES)) {
      let continuationToken;

      do {
        const query = continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : '';
        const body = await this._request(
          'POST',
          `${HOST}/bim360/relationship/v2/containers/${containerId}/relationships:intersect${query}`,
          {
            body: { entities: group, ...(withEntities ? { withEntities } : {}) },
            signal,
            region: true,
            context: 'het zoeken naar gekoppelde assets',
          },
        );

        all.push(...(body.relationships ?? []));
        continuationToken = body.page?.continuationToken;
      } while (continuationToken);
    }

    return all;
  }

  /**
   * The question this tool actually asks: which assets hang off these forms?
   *
   * Two things this has to get right, both seen in real project data:
   *
   *   - The two entities come back in no fixed order — sometimes the form is
   *     first, sometimes the asset. Matching is by domain and type, never by
   *     position.
   *   - `autodesk-bim360-asset` holds more than assets. A form can also be
   *     linked to `autodesk-bim360-asset/system`, and forms are linked to
   *     `autodesk-construction-schedule/task` as well. Matching on the domain
   *     alone would quietly treat a system id as an asset id, which then
   *     disappears in getAssetsByIds because unknown ids are dropped without
   *     an error. Hence the type check.
   *
   * @param {object} params
   * @param {string} params.containerId
   * @param {string[]} params.formIds
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<Map<string, string[]>>} formId → assetIds (every
   *   requested form is present, with an empty array if it has none).
   */
  async findAssetIdsForForms({ containerId, formIds, signal } = {}) {
    /** @type {Map<string, string[]>} */
    const byForm = new Map(formIds.map((id) => [id, []]));

    const relationships = await this.intersectRelationships({
      containerId,
      entities: formIds.map((id) => ({ domain: FORM_DOMAIN, type: FORM_TYPE, id })),
      withEntities: [{ domain: ASSET_DOMAIN, type: ASSET_TYPE }],
      signal,
    });

    for (const relationship of relationships) {
      if (relationship.isDeleted) continue;

      const entities = relationship.entities ?? [];
      const form = entities.find((e) => e.domain === FORM_DOMAIN && e.type === FORM_TYPE);
      const asset = entities.find((e) => e.domain === ASSET_DOMAIN && e.type === ASSET_TYPE);
      if (!form || !asset) continue;

      const bucket = byForm.get(form.id);
      // Guard against a form we did not ask about, and against duplicates from
      // overlapping chunks.
      if (bucket && !bucket.includes(asset.id)) bucket.push(asset.id);
    }

    return byForm;
  }

  // ---------------------------------------------------------------------------
  // Assets and categories
  // ---------------------------------------------------------------------------

  /**
   * Assets by id. Unknown ids are silently dropped by the API, so the result
   * may be shorter than what you asked for.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string[]} params.ids
   * @param {number} [params.batchSize]
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object[]>}
   */
  async getAssetsByIds({ projectId, ids, batchSize = 50, signal } = {}) {
    const project = normalizeProjectId(projectId);
    const results = [];

    for (const group of chunk([...new Set(ids)], batchSize)) {
      const body = await this._request(
        'POST',
        `${HOST}/construction/assets/v2/projects/${project}/assets:batch-get`,
        { body: { ids: group }, signal, context: 'het ophalen van de assets' },
      );
      results.push(...(body.results ?? []));
    }

    return results;
  }

  /**
   * The full category tree.
   *
   * Categories are on v1 while assets are on v2 — not a typo.
   *
   * There is no ready-made path field: a category knows only its `parentId`,
   * so the `1->Ba->24` path is assembled by walking upwards. Fetch this once
   * per run and keep it in memory.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object[]>}
   */
  async listCategories({ projectId, signal } = {}) {
    const body = await this._request(
      'GET',
      `${HOST}/construction/assets/v1/projects/${normalizeProjectId(projectId)}/categories`,
      { signal, context: 'het ophalen van de categorieën' },
    );
    return body.results ?? body.data ?? [];
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /**
   * One HTTP call, with the things every APS call needs: a bearer token, a
   * retry on 429/5xx, and a single retry after re-authenticating on 401.
   *
   * @param {string} method
   * @param {string} url
   * @param {object} [options]
   * @param {unknown} [options.body]
   * @param {boolean} [options.region]   Send x-ads-region (relationships only).
   * @param {string} [options.context]   Used in the Dutch error message.
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.attempt]
   * @param {boolean} [options.reauthenticated]
   */
  async _request(method, url, options = {}) {
    const { body, region = false, context, signal, attempt = 0, reauthenticated = false } = options;

    const headers = { Authorization: `Bearer ${await this.auth.getAccessToken()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Only the relationship service documents this header, and BatchFormCreator
    // sends it on every relationship call against the EU tenant.
    if (region) headers['x-ads-region'] = this.region;

    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers,
        signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      if (attempt < this.maxRetries) {
        await sleep(this._backoffMs(attempt));
        return this._request(method, url, { ...options, attempt: attempt + 1 });
      }
      throw new ApsError('network', 'Geen verbinding met ACC.', { cause, url });
    }

    if (response.ok) {
      // 204 on some endpoints; nothing to parse.
      if (response.status === 204) return {};
      return response.json().catch(() => ({}));
    }

    // An expired token can slip through when the clock drifts. Refresh once,
    // then give up rather than looping.
    if (response.status === 401 && !reauthenticated) {
      return this._request(method, url, { ...options, reauthenticated: true, attempt });
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < this.maxRetries) {
      await sleep(this._retryAfterMs(response) ?? this._backoffMs(attempt));
      return this._request(method, url, { ...options, attempt: attempt + 1 });
    }

    const detail = await response.text().catch(() => undefined);
    const { kind, message } = describeStatus(response.status, context);
    throw new ApsError(kind, message, { status: response.status, detail, url });
  }

  /** Honours Retry-After when ACC sends it; seconds or an HTTP date. */
  _retryAfterMs(response) {
    const header = response.headers?.get?.('Retry-After');
    if (!header) return undefined;

    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;

    const date = Date.parse(header);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
  }

  /** Exponential backoff with jitter, so a batch does not retry in lockstep. */
  _backoffMs(attempt) {
    return Math.round(2 ** attempt * 500 * (1 + Math.random()));
  }
}
