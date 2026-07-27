# ACC Form Stamper

Zet de gekoppelde assets van een ACC-formulier in het notitieveld van dat
formulier, zodat formulieren in Forma Build alsnog te filteren zijn op assetnaam
en assetcategorie — iets wat de Forms-module zelf niet kan.

Bedoeld voor formulieren die er al staan. Nieuwe formulieren krijgen hun stempel
bij het aanmaken, via de bestaande Power Automate-flow `BatchFormCreator`.

## Vorm

Een Edge-extensie. De gebruiker filtert en selecteert formulieren in ACC Build
zelf, klikt op een knop, en de extensie stempelt de selectie. Geen installatie,
geen `.exe`, geen server. Authenticatie via een eigen APS-app met 3-legged
OAuth (PKCE), zodat de rechten van de gebruiker zelf gelden.

## Status

De extensie is compleet: alle vier de stappen zijn gebouwd en aangesloten op de
echte API. De selectie wordt uit ACC gelezen, de tabel laat per formulier zien
wat er gaat gebeuren, het stempelen schrijft formulier voor formulier weg, en
elke uitvoering is terug te draaien.

Nog niet gedaan: een echte run over een grote selectie. Wat er getest is, is de
logica (31 tests) en losse formulieren met de hand.

| | |
|---|---|
| [`docs/workflow.md`](docs/workflow.md) | Wat de tool doet: stempelformaat, de gemaakte keuzes, en waarom |
| [`docs/api-notes.md`](docs/api-notes.md) | Wat we van de APS/ACC-API weten — met per punt of het bewezen of aangenomen is |
| [`docs/ux-brief.md`](docs/ux-brief.md) | Schermen, toestanden en gebruikersinvoer — het functionele startpunt |
| [`docs/design_handoff_form_stamper/`](docs/design_handoff_form_stamper/) | Het visuele ontwerp: vier schermen, huisstijl, en de UX-flow |
| [`docs/design-decisions.md`](docs/design-decisions.md) | Wat de bouw doet waar het ontwerp zwijgt — lees dit vóór je aan het paneel werkt |
| [`src/aps/`](src/aps/) | De APS-koppeling: aanmelden en de REST-aanroepen |
| [`src/popup/`](src/popup/) | Het paneel zelf |
| [`src/content/`](src/content/) | Leest de aangevinkte formulieren uit de ACC-pagina |
| [`src/stamp.js`](src/stamp.js) | De stempellogica, puur en getest |
| [`poc/selection-probe/`](poc/selection-probe/) | Meetinstrument: kan de extensie de selectie uit de ACC-UI lezen? |
| [`.claude/skills/`](.claude/skills/) | `aps-docs` en `aps-sdk-openapi` — hiermee zoek je de APS-referentie op in plaats van te gokken |

## Draaien

Laad `src/` als uitgepakte extensie via `edge://extensions` (ontwikkelaarsmodus
aan). Het `key`-veld in de manifest houdt het extensie-id vast, en daarmee de
callback-URL die bij Autodesk geregistreerd staat — laad dus `src/` zelf, niet
een kopie.

De tests:

```
node --test src/stamp.test.js src/journaal.test.js
```

`stamp.test.js` dekt de stempellogica (puur, geen browser). `journaal.test.js`
laadt de service worker met een nagebootste `chrome` en `FormaClient`, en test
het schrijven, het opnieuw proberen en het terugdraaien zonder ACC aan te raken.

## Waar het nu staat

De hele opzet leunde op een aantal dingen die geen van alle gedocumenteerd zijn
door Autodesk. Op 27-07-2026 zijn ze gemeten, en allemaal gunstig.

**De selectie is uitleesbaar, op formulier-id.** De formulierenlijst is een
TanStack Table met `getRowId: e => e.uid`, en `getState().rowSelection` bevat de
aangevinkte formulieren als GUID-sleutels. Diezelfde GUID staat in de adresbalk
van het formulier en is wat de publieke API verwacht. De extensie hoeft de DOM
dus niet aan te raken — het fragielste stuk van het plan is van tafel.

**Gesloten formulieren kunnen heropend worden.** `submitted` → `draft` →
notities → `submitted` werkt in één sessie. Wel met een prijs: het opnieuw
sluiten overschrijft "gesloten door" en "gesloten op", en dát is niet terug te
draaien. De optie blijft dus bestaan, maar standaard uit en met uitleg.

**PDF-formulieren zijn gewoon te stempelen.** De referentie zegt van niet, en
daar was het ontwerp op ingericht: eruit filteren, met een melding. De meting zegt
iets anders — schrijven, teruglezen en terugzetten slaagden alle vier. Er hoeft
dus niets gefilterd te worden, wat een tag, een teller en een uitleg scheelt.

Dat is drie van de drie: elke ongedocumenteerde beperking waar we op zijn gaan
meten, viel bij meting de andere kant op. Waard om te onthouden bij de volgende.

Alle metingen staan met hun uitkomst in [`docs/api-notes.md`](docs/api-notes.md).

## Volgende stappen

1. **Draaien op een echte selectie.** De logica is getest, de schaal niet. Doe
   een run van tien à twintig formulieren op een testproject, draai hem terug, en
   kijk of het journaal klopt met wat er in ACC staat.
2. **`BatchFormCreator` gelijktrekken** met het stempelformaat, zodat nieuwe en
   bijgewerkte formulieren niet van elkaar te onderscheiden zijn voor een filter.
3. **Uitzoeken of `include=layoutInfo` per sjabloon vertelt of het notitieblok
   aan staat.** Zo ja, dan kan de vaste uitleg over Filters → Opmerkingen een
   signaal per rij worden — preciezer dan de algemene tekst die er nu staat.

Vóór dit tegen een echt project draait: `PROBE_CONFIRM_DEFAULT` in
[`src/background.js`](src/background.js) staat op `true` omdat er op
testprojecten gemeten wordt. Terugzetten op `false`.
