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

Verkenning afgerond, bouwen kan beginnen. De twee metingen die het ontwerp
konden omgooien zijn gedaan en vielen goed uit. Er wordt nog niets gestempeld
op schaal — wel is één formulier met de hand gestempeld en teruggedraaid.

| | |
|---|---|
| [`docs/workflow.md`](docs/workflow.md) | Wat de tool doet: stempelformaat, de gemaakte keuzes, en waarom |
| [`docs/api-notes.md`](docs/api-notes.md) | Wat we van de APS/ACC-API weten — met per punt of het bewezen of aangenomen is |
| [`docs/ux-brief.md`](docs/ux-brief.md) | Schermen, toestanden en gebruikersinvoer — startpunt voor het ontwerp |
| [`src/aps/`](src/aps/) | De APS-koppeling: aanmelden en de REST-aanroepen |
| [`poc/selection-probe/`](poc/selection-probe/) | Meetinstrument: kan de extensie de selectie uit de ACC-UI lezen? |
| [`.claude/skills/`](.claude/skills/) | `aps-docs` en `aps-sdk-openapi` — hiermee zoek je de APS-referentie op in plaats van te gokken |

## Waar het nu staat

De hele opzet leunde op twee dingen die geen van beide gedocumenteerd zijn door
Autodesk. Op 27-07-2026 zijn ze allebei gemeten, en allebei gunstig.

**De selectie is uitleesbaar, op formulier-id.** De formulierenlijst is een
TanStack Table met `getRowId: e => e.uid`, en `getState().rowSelection` bevat de
aangevinkte formulieren als GUID-sleutels. Diezelfde GUID staat in de adresbalk
van het formulier en is wat de publieke API verwacht. De extensie hoeft de DOM
dus niet aan te raken — het fragielste stuk van het plan is van tafel.

**Gesloten formulieren kunnen heropend worden.** `submitted` → `draft` →
notities → `submitted` werkt in één sessie. Wel met een prijs: het opnieuw
sluiten overschrijft "gesloten door" en "gesloten op", en dát is niet terug te
draaien. De optie blijft dus bestaan, maar standaard uit en met uitleg.

Beide metingen staan met hun uitkomst in [`docs/api-notes.md`](docs/api-notes.md).

## Volgende stappen

1. **Kern bouwen.** De stempellogica — het afgeschermde blok, het opbouwen van
   categoriepaden, de afbouwladder bij 8000 tekens — hangt nergens meer van af.
2. **Selectie doorgeven.** Een content script dat `rowSelection` uitleest en de
   id's naar de service worker stuurt. Let op: lees de **sleutels van
   `rowSelection`**, niet `getSelectedRowModel()` — de tabel houdt maar één
   pagina van 50 vast, de selectie zelf overleeft het doorbladeren wel.
3. **Paneel bouwen** volgens [`docs/ux-brief.md`](docs/ux-brief.md).
4. **`BatchFormCreator` gelijktrekken** met het stempelformaat, zodat nieuwe en
   bijgewerkte formulieren niet van elkaar te onderscheiden zijn voor een filter.
