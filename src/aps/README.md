# APS-koppeling

Drie modules. Ze kennen de ACC-API's en verder niets — geen UI, geen
stempellogica, geen kennis van wat een "run" is.

| | |
|---|---|
| `auth.js` | `ApsAuth` — 3-legged aanmelden met PKCE, tokens bewaren en verversen |
| `forma.js` | `FormaClient` — de REST-aanroepen: formulieren, relaties, assets, categorieën |
| `errors.js` | `ApsError` — één fouttype, met Nederlandse tekst voor de gebruiker |

Achtergrond en bronvermelding per endpoint: [`../../docs/api-notes.md`](../../docs/api-notes.md).

## Waar deze code draait

In de **service worker**, niet in een content script.

Twee redenen. `chrome.identity.launchWebAuthFlow` bestaat alleen in
extensiecontext, en aanroepen naar `developer.api.autodesk.com` vanuit een
content script lopen tegen CORS aan — de host-permissies van de extensie gelden
daar niet. Het paneel op de pagina stuurt dus berichten naar de service worker,
en die praat met ACC.

## Eerst instellen

De APS-app bestaat al: **HeijmanstoolsForma_Apps**, type *Desktop, Mobile,
Single-Page Web App*, grant type *Authorization Code with PKCE*. De client id
staat in [`../config.js`](../config.js).

Wat er nog moet gebeuren:

1. **Zet deze callback-URL bij de app in APS:**

   ```
   https://lcelfplffcnfhajffomdelokagjkggnf.chromiumapp.org/
   ```

   Geen localhost. `chrome.identity.launchWebAuthFlow` onderschept alleen
   redirects naar `chromiumapp.org`; er wordt geen lokale server gestart, dus een
   `http://localhost:8080/...` callback blijft eeuwig hangen.

2. **Geef de app toegang tot het ACC-account** via *Custom Integrations* in de
   accountinstellingen. Sla je dit over, dan krijg je een 403 die op een
   rechtenprobleem van de gebruiker lijkt — maar het is de app die er niet in mag.

3. **Zet zowel de ACC-API als de BIM 360-API aan op de app.** De formulieren en
   assets zitten achter de ACC-API, de relatieservice achter die van BIM 360.
   Staat de tweede uit, dan werkt het ophalen van formulieren gewoon terwijl
   élke relatie-aanroep 403 geeft — inclusief `utility/relationships:writable`,
   die niet eens een container aanraakt. Dat laatste is het herkenningspunt.

### Waar dat extensie-id vandaan komt

Het id van een uitgepakte extensie wordt normaal afgeleid uit het pad van de map.
Bij iedere collega en op iedere machine is dat dus een ander id, en daarmee een
andere callback-URL — terwijl APS alleen accepteert wat geregistreerd staat.

Daarom staat er een `key` in `manifest.json`: de publieke helft van een
sleutelpaar. Die legt het id vast op `lcelfplffcnfhajffomdelokagjkggnf`, overal en
altijd. De publieke helft mag gerust in git staan; de privésleutel
(`extension-key.pem` in de repowortel) niet, en die staat dan ook in
`.gitignore`. Bewaar hem ergens veilig — je hebt hem nodig zodra je de extensie
wilt inpakken als `.crx`.

Het id is te herleiden uit de key: SHA-256 van de DER-sleutel, de eerste 16 bytes,
en elk hex-teken `0-f` vertaald naar `a-p`.

### Controleren of het klopt

`assertRedirectUri()` in `config.js` vergelijkt wat de browser teruggeeft met wat
hierboven staat. `background.js` roept die aan vóór het aanmelden, zodat een
verkeerd geregistreerde URL een begrijpelijke melding oplevert in plaats van
Autodesks kale `invalid redirect_uri`.

## Gebruik

```js
import { ApsAuth } from './aps/auth.js';
import { FormaClient } from './aps/forma.js';

const auth = new ApsAuth({ clientId: APS_CLIENT_ID });
const forma = new FormaClient({ auth, region: 'EMEA' });

if (!(await auth.isSignedIn())) await auth.signIn();

// Welke assets hangen aan deze formulieren?
const perForm = await forma.findAssetIdsForForms({ containerId, formIds });

// Namen en categorieën erbij halen
const assets = await forma.getAssetsByIds({ projectId, ids: [...new Set(perForm.values().flat?.() ?? [])] });
const categories = await forma.listCategories({ projectId });

// Schrijven
await forma.setFormNotes({ projectId, templateId, formId, notes });
```

## Wat je moet weten voordat je hierop verderbouwt

- **`templateId` is nodig om te kunnen schrijven.** Die staat in de lijstaanroep
  als `formTemplateId` en moet je meedragen; een formulier-id alleen is niet
  genoeg.
- **`containerId` is niet de `projectId`.** Voor de relatieservice is dat een
  aparte GUID. Volgens `BatchFormCreator` zijn ze in de praktijk gelijk, maar
  behandel ze als twee dingen.
- **Lezen gaat via v2, schrijven via v1**, en de statuswaarden verschillen
  daartussen. `STATUS_V1_TO_V2` en `STATUS_V2_TO_V1` doen de vertaling. Bewaar
  intern de v1-waarde: dat is wat een terugdraaiactie moet terugschrijven.
- **PDF-formulieren zijn niet te patchen.** Filter ze eruit vóór het
  voorbeeldscherm.
- **`intersectRelationships` hakt zelf in blokken van 20**, want daar ligt de
  grens van de API. Je mag er gerust 300 formulieren in gooien.
- **De volgorde van de twee entiteiten in een relatie ligt niet vast.**
  `findAssetIdsForForms` matcht daarom op domein, niet op positie. Doe dat ook
  als je zelf relaties uitleest.

## Nog niet gebouwd

Het heropenen van gesloten formulieren. Dát het kan, is bewezen met
`stamper.probeReopen` in `background.js` (27-07-2026); de volgorde is
`status: 'draft'` → `notes` → `status: 'submitted'`. Er is geen aparte methode
voor nodig — `updateForm` accepteert een `status` in de patch.

Drie dingen om erbij te weten:

- **Heropen naar `draft`, nooit naar `in_review`.** Die tussenstap moet in het
  sjabloon aangezet zijn.
- **Het opnieuw sluiten overschrijft `lastSubmittedAt`, `lastSubmittedBy` en
  `lastStatusChanges.closed`.** Onherstelbaar. Het journaal kan notities en
  status terugzetten, deze velden niet.
- **Het antwoord van de v1-`PATCH` is geen v2-record.** Andere statuswaarden,
  `formTemplate` in plaats van `formTemplateId`. Lees na een schrijfactie
  opnieuw via v2 als je het record nodig hebt.
