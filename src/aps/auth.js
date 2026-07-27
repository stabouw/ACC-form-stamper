/**
 * Three-legged APS authentication for the extension (PKCE, public client).
 *
 * The tool acts on the user's behalf with the user's own permissions, so there
 * is no client secret anywhere and nothing is stored server-side. The browser
 * does the consent step; we keep the resulting tokens in extension storage.
 *
 * Contract verified against authentication.yaml (APS OpenAPI, v2):
 *   - Desktop/mobile/single-page apps send `client_id` in the form body.
 *     Basic auth is for confidential clients only — we are not one.
 *   - Authorization code is valid 5 minutes, access token 60 minutes,
 *     refresh token 15 days.
 *
 * Must run somewhere with access to chrome.identity — the service worker, not
 * a content script.
 */

import { ApsError } from './errors.js';

const AUTH_BASE = 'https://developer.api.autodesk.com/authentication/v2';

/** Refresh this long before actual expiry, so a call never races the clock. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Scopes this tool needs, and why:
 *   data:read   relaties, assets, categorieën en de formulierenlijst
 *   data:write  het bijwerken van de notities
 *   account:read  de projectnaam via de Account Admin-API. Die dienst hangt
 *                 níét onder data:read — met alleen data:read geeft hij 403,
 *                 wat op een rechtenprobleem lijkt terwijl het een scope is.
 *   offline_access  levert een refresh token, zodat de gebruiker niet elk uur
 *                   opnieuw hoeft te tekenen. Deze staat niet in de enum van de
 *                   OpenAPI-spec, maar wel in de scope-documentatie; de enum is
 *                   daar niet uitputtend.
 */
export const DEFAULT_SCOPES = ['data:read', 'data:write', 'account:read', 'offline_access'];

const STORAGE_KEY = 'aps.tokens';

// -----------------------------------------------------------------------------
// PKCE helpers
// -----------------------------------------------------------------------------

/** RFC 4648 §5 base64url, no padding. */
function base64url(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 48) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** S256: SHA-256 of the verifier, base64url encoded. */
async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

// -----------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------

/** Default store: chrome.storage.local, promisified. */
const chromeStorage = {
  async get(key) {
    const bag = await chrome.storage.local.get(key);
    return bag[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

// -----------------------------------------------------------------------------
// ApsAuth
// -----------------------------------------------------------------------------

/**
 * @typedef {object} TokenSet
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} expiresAt      Epoch ms, already includes the safety margin.
 * @property {string} scope
 */

export class ApsAuth {
  /**
   * @param {object} options
   * @param {string} options.clientId          Client ID of the APS app.
   * @param {string[]} [options.scopes]
   * @param {string} [options.redirectUri]     Defaults to the extension's own
   *   chromiumapp.org URL. Whatever this resolves to must be registered as the
   *   callback URL on the APS app, character for character.
   * @param {object} [options.storage]         Injectable for tests.
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({ clientId, scopes = DEFAULT_SCOPES, redirectUri, storage = chromeStorage, fetchImpl } = {}) {
    if (!clientId) throw new Error('ApsAuth: clientId is verplicht');

    this.clientId = clientId;
    this.scopes = scopes;
    this.storage = storage;
    this.fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this._redirectUri = redirectUri;

    /**
     * In-flight refresh, shared by every caller.
     *
     * A run fires many requests at once; without this they would each notice
     * the expired token and kick off their own refresh, and all but one of
     * those would fail because the refresh token had already been rotated.
     * @type {Promise<TokenSet>|null}
     */
    this._refreshing = null;
  }

  get redirectUri() {
    return this._redirectUri ?? chrome.identity.getRedirectURL();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** @returns {Promise<boolean>} True if we hold a token that can still be used or refreshed. */
  async isSignedIn() {
    const tokens = await this._load();
    if (!tokens) return false;
    if (!this._scopesVolstaan(tokens)) return false;
    return Boolean(tokens.refreshToken) || tokens.expiresAt > Date.now();
  }

  /**
   * Dekt de opgeslagen toekenning alles wat we nú nodig hebben?
   *
   * Komt er een scope bij in een nieuwe versie, dan is een token van vóór die
   * versie te smal. Verversen lost dat niet op: een refresh mag nooit méér
   * vragen dan er is toegekend, dus die faalt.
   *
   * Zonder deze controle blijft dat een uur onzichtbaar — het oude access token
   * werkt nog, alleen de nieuwe aanroep geeft 403 — en pas daarna volgt een
   * verlopen-melding die niets met de werkelijke oorzaak te maken lijkt te
   * hebben. Zo merkt de gebruiker het meteen: één keer opnieuw aanmelden.
   *
   * @param {TokenSet} tokens
   */
  _scopesVolstaan(tokens) {
    const toegekend = new Set((tokens.scope ?? '').split(/\s+/).filter(Boolean));
    return this.scopes.every((scope) => toegekend.has(scope));
  }

  /**
   * Runs the interactive consent flow. Safe to call when already signed in —
   * it simply replaces the stored tokens.
   *
   * @returns {Promise<TokenSet>}
   */
  async signIn() {
    const verifier = randomString();
    const challenge = await challengeFor(verifier);
    const state = randomString(16);
    const nonce = randomString(16);

    const authorizeUrl = new URL(`${AUTH_BASE}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: this.scopes.join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();

    let redirect;
    try {
      redirect = await chrome.identity.launchWebAuthFlow({
        url: authorizeUrl.toString(),
        interactive: true,
      });
    } catch (cause) {
      // Also what you get when the user simply closes the window.
      throw new ApsError('auth', 'Aanmelden is afgebroken.', { cause });
    }

    if (!redirect) {
      throw new ApsError('auth', 'Aanmelden is afgebroken.');
    }

    const params = new URL(redirect).searchParams;

    if (params.get('error')) {
      throw new ApsError('auth', 'Autodesk heeft de aanmelding geweigerd.', {
        detail: params.get('error_description') ?? params.get('error'),
      });
    }

    // Guards against a callback that is not the one we asked for.
    if (params.get('state') !== state) {
      throw new ApsError('auth', 'Aanmelden is afgebroken: onverwacht antwoord.');
    }

    const code = params.get('code');
    if (!code) {
      throw new ApsError('auth', 'Aanmelden leverde geen toegangscode op.');
    }

    return this._exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: verifier,
    });
  }

  /**
   * Returns a usable access token, refreshing it if needed.
   *
   * Throws an ApsError of kind 'auth' when the user has to sign in again; the
   * UI should treat that as "back to the Aanmelden screen", not as a failed
   * form.
   *
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    const tokens = await this._load();

    if (!tokens) {
      throw new ApsError('auth', 'Je bent niet aangemeld bij Autodesk.');
    }
    if (tokens.expiresAt > Date.now()) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      throw new ApsError('auth', 'Je aanmelding is verlopen. Meld je opnieuw aan.');
    }

    const refreshed = await this._refresh(tokens.refreshToken);
    return refreshed.accessToken;
  }

  /**
   * Drops the stored tokens. Best-effort revoke at APS first — if that fails
   * we still forget them locally, because the user asked to be signed out.
   */
  async signOut() {
    const tokens = await this._load();
    await this.storage.remove(STORAGE_KEY);

    if (!tokens) return;

    for (const [token, hint] of [
      [tokens.refreshToken, 'refresh_token'],
      [tokens.accessToken, 'access_token'],
    ]) {
      if (!token) continue;
      try {
        await this.fetch(`${AUTH_BASE}/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, token_type_hint: hint, client_id: this.clientId }),
        });
      } catch {
        // Nothing useful to do; the local tokens are already gone.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** @returns {Promise<TokenSet|undefined>} */
  async _load() {
    return this.storage.get(STORAGE_KEY);
  }

  /** Single-flight refresh — see the note on `_refreshing`. */
  _refresh(refreshToken) {
    if (this._refreshing) return this._refreshing;

    this._refreshing = this._exchange({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: this.scopes.join(' '),
    })
      .catch(async (error) => {
        // A refresh token is good for 15 days. Once it is rejected there is no
        // way back other than signing in again, so do not keep it around.
        await this.storage.remove(STORAGE_KEY);
        throw error instanceof ApsError
          ? error
          : new ApsError('auth', 'Je aanmelding is verlopen. Meld je opnieuw aan.', { cause: error });
      })
      .finally(() => {
        this._refreshing = null;
      });

    return this._refreshing;
  }

  /**
   * Posts to the token endpoint and stores the result.
   * @returns {Promise<TokenSet>}
   */
  async _exchange(fields) {
    const body = new URLSearchParams({ ...fields, client_id: this.clientId });

    let response;
    try {
      response = await this.fetch(`${AUTH_BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (cause) {
      throw new ApsError('network', 'Geen verbinding met Autodesk.', { cause });
    }

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new ApsError('auth', 'Aanmelden bij Autodesk is mislukt.', {
        status: response.status,
        detail: payload.error_description ?? payload.error ?? payload,
      });
    }

    /** @type {TokenSet} */
    const tokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      // expires_in is seconds; subtract the margin so callers never hand a
      // token to ACC that expires mid-flight.
      expiresAt: Date.now() + payload.expires_in * 1000 - REFRESH_MARGIN_MS,
      scope: payload.scope ?? this.scopes.join(' '),
    };

    await this.storage.set(STORAGE_KEY, tokens);
    return tokens;
  }
}
