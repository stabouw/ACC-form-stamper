/**
 * Instellingen van de APS-app.
 *
 * De client id is geen geheim. Deze app is geregistreerd als publieke client
 * (Desktop/Mobile/SPA met PKCE), en heeft dus geen client secret. De id staat
 * bij elke aanmelding gewoon in de adresbalk. Hij mag hier staan.
 *
 * APS-app: HeijmanstoolsForma_Apps
 */

export const APS_CLIENT_ID = 'ywbIFfLmnpejUxLwI5oTW4Ap7GixIDOAoJfAkk11ch4ruNhJ';

/**
 * Regio van de ACC-omgeving. EMEA hoort bij acc.autodesk.eu.
 * @type {'US'|'EMEA'}
 */
export const ACC_REGION = 'EMEA';

/**
 * De callback-URL die bij Autodesk geregistreerd moet staan.
 *
 *   https://lcelfplffcnfhajffomdelokagjkggnf.chromiumapp.org/
 *
 * Die komt niet uit de lucht vallen: `chrome.identity.launchWebAuthFlow` vangt
 * alleen redirects naar `<extensie-id>.chromiumapp.org` op, en het extensie-id
 * ligt vast via het `key`-veld in manifest.json. Zolang die key niet verandert,
 * verandert deze URL ook niet — op welke machine de extensie ook geladen wordt.
 *
 * We geven de URL niet mee aan ApsAuth: die vraagt hem zelf op bij de browser,
 * zodat de code niet uit de pas kan lopen met de werkelijkheid. Gebruik
 * `assertRedirectUri()` hieronder als je wilt controleren dat ze nog gelijk zijn.
 */
export const EXPECTED_REDIRECT_URI = 'https://lcelfplffcnfhajffomdelokagjkggnf.chromiumapp.org/';

/**
 * Controleert of de browser dezelfde callback-URL teruggeeft als de URL die bij
 * Autodesk geregistreerd is.
 *
 * Loopt dat uiteen, dan mislukt het aanmelden met een vage foutmelding van
 * Autodesk. Deze controle zet dat om in een melding die zegt wat er aan de hand
 * is.
 *
 * @returns {{ok: boolean, actual: string, expected: string}}
 */
export function assertRedirectUri() {
  const actual = chrome.identity.getRedirectURL();
  return { ok: actual === EXPECTED_REDIRECT_URI, actual, expected: EXPECTED_REDIRECT_URI };
}
