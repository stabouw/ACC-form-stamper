/**
 * Shared error type for everything that talks to APS.
 *
 * Every failure that reaches the UI should be one of these, so the panel can
 * decide what to show without parsing raw fetch errors. User-facing text is
 * Dutch; `detail` stays in whatever APS sent back and is for the log only.
 */

/** @typedef {'auth'|'permission'|'notfound'|'conflict'|'ratelimit'|'server'|'network'|'client'} ApsErrorKind */

export class ApsError extends Error {
  /**
   * @param {ApsErrorKind} kind
   * @param {string} message  Dutch, shown to the user.
   * @param {object} [options]
   * @param {number} [options.status]   HTTP status, if there was one.
   * @param {unknown} [options.detail]  Raw response body, for the log.
   * @param {string} [options.url]
   * @param {Error} [options.cause]
   */
  constructor(kind, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'ApsError';
    this.kind = kind;
    this.status = options.status;
    this.detail = options.detail;
    this.url = options.url;
  }

  /** Whether retrying the exact same call could plausibly succeed. */
  get retryable() {
    return this.kind === 'ratelimit' || this.kind === 'server' || this.kind === 'network';
  }

  /** Whether the user has to sign in again before anything else will work. */
  get needsSignIn() {
    return this.kind === 'auth';
  }
}

/**
 * Maps an HTTP status onto a kind plus a Dutch message.
 *
 * The messages deliberately say what the user can do about it. A status code
 * on its own tells a werkvoorbereider nothing.
 *
 * @param {number} status
 * @param {string} [context]  Short description of what was being done.
 * @returns {{kind: ApsErrorKind, message: string}}
 */
export function describeStatus(status, context = 'de aanvraag') {
  if (status === 400) {
    return { kind: 'client', message: `ACC wees ${context} af als ongeldig.` };
  }
  if (status === 401) {
    return { kind: 'auth', message: 'Je aanmelding is verlopen. Meld je opnieuw aan.' };
  }
  if (status === 403) {
    return { kind: 'permission', message: `Je hebt geen rechten voor ${context}.` };
  }
  if (status === 404) {
    return { kind: 'notfound', message: `Niet gevonden: ${context}.` };
  }
  if (status === 409) {
    return {
      kind: 'conflict',
      message: 'Dit formulier is inmiddels door iemand anders gewijzigd.',
    };
  }
  if (status === 429) {
    return { kind: 'ratelimit', message: 'ACC krijgt te veel verzoeken tegelijk.' };
  }
  if (status >= 500) {
    return { kind: 'server', message: 'ACC is tijdelijk niet bereikbaar.' };
  }
  return { kind: 'client', message: `Onverwachte fout (${status}) bij ${context}.` };
}
