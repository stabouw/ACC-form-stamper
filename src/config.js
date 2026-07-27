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
 * Het ACC-account van Heijmans, oftewel de hub.
 *
 * Hub-id en account-id zijn hetzelfde nummer: de hub heet
 * `b.129f2f98-4635-42b4-8550-6b6087bf0514`, en de Admin-API wil dat zonder het
 * `b.`-voorvoegsel — net als bij project-id's.
 *
 * Wordt nu nergens voor gebruikt: de projectnaam komt van
 * `GET /construction/admin/v1/projects/:projectId`, en die heeft geen account
 * nodig. De account-variant (`/accounts/:accountId/projects`) kan alleen
 * filteren op classificatie, platform en product — niet op project-id — dus
 * daarmee zou je de hele hub moeten doorbladeren om één naam te vinden.
 *
 * Staat hier omdat elke andere Admin-aanroep hem wél nodig heeft, en omdat het
 * anders elke keer opnieuw uitzoeken is.
 */
export const ACC_ACCOUNT_ID = '129f2f98-4635-42b4-8550-6b6087bf0514';

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
