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

Verkenning. Er wordt nog niets gestempeld, en er staat nog geen productiecode
in deze repo.

| | |
|---|---|
| [`docs/workflow.md`](docs/workflow.md) | Wat de tool doet: stempelformaat, de gemaakte keuzes, en waarom |
| [`docs/api-notes.md`](docs/api-notes.md) | Wat we van de APS/ACC-API weten — met per punt of het bewezen of aangenomen is |
| [`docs/ux-brief.md`](docs/ux-brief.md) | Schermen, toestanden en gebruikersinvoer — startpunt voor het ontwerp |
| [`src/aps/`](src/aps/) | De APS-koppeling: aanmelden en de REST-aanroepen |
| [`poc/selection-probe/`](poc/selection-probe/) | Meetinstrument: kan de extensie de selectie uit de ACC-UI lezen? |
| [`.claude/skills/`](.claude/skills/) | `aps-docs` en `aps-sdk-openapi` — hiermee zoek je de APS-referentie op in plaats van te gokken |

## Waar het nu staat

De hele opzet leunt op één ding: kan een extensie uitlezen welke formulieren de
gebruiker heeft aangevinkt? Dat is niet gedocumenteerd door Autodesk en niet
gegarandeerd houdbaar.

De eerste meting was gunstig. De formulierenlijst is een TanStack Table, en de
rij-objecten bevatten `uid` (vermoedelijk de formulier-id) en `type`
(vermoedelijk de template-id). Beide zijn nodig om een formulier te kunnen
bijwerken, en beide staan er dus al.

## Volgende stappen

1. **Meting afronden.** Laad `poc/selection-probe` uitgepakt in Edge en draai
   *Probe tabel* met een paar formulieren aangevinkt. Dat laat zien of
   `getSelectedRowModel()` de selectie geeft. Zo ja, dan hoeft de extensie de
   DOM niet aan te raken en is het meest fragiele stuk van het plan van tafel.
2. **`uid` verifiëren.** Open één formulier in ACC en vergelijk de GUID in de
   adresbalk met de `uid` uit het rapport. Er zitten meerdere id-achtige velden
   in een rij, waaronder PlanGrid-interne sleutels.
3. **Eén API-vraag beantwoorden.** De documentatie is ontsloten en verwerkt in
   `api-notes.md`: de richting van de relatiezoekopdracht bleek geen probleem, en
   het stempelveld `notes` heeft inderdaad een grens van 8000 tekens. Wat
   overblijft is één vraag die je alleen met een testaanroep beantwoordt: kan een
   gesloten formulier via de API heropend worden? Zo niet, dan vervalt die optie.
4. **Kern eerst bouwen.** De stempellogica — het afgeschermde blok, het opbouwen
   van categoriepaden, de afbouwladder bij 8000 tekens — hangt van geen van
   bovenstaande af en is los te schrijven en te testen.

De volgorde is niet vrijblijvend: valt stap 1 tegen, dan verandert de vorm van
de tool, maar stap 4 blijft in alle gevallen overeind.
