# ACC Form Stamper

Zet de gekoppelde assets van een ACC-formulier in het notitieveld van dat
formulier, zodat formulieren in Forma Build alsnog te filteren zijn op assetnaam
en assetcategorie — iets wat de Forms-module zelf niet kan.

Bedoeld voor formulieren die er al staan. Nieuwe formulieren krijgen hun stempel
bij het aanmaken, via de bestaande Power Automate-flow `BatchFormCreator`.

## Status

In ontwerp. Er wordt nog niets gestempeld.

| | |
|---|---|
| [`docs/workflow.md`](docs/workflow.md) | Wat de tool doet, het stempelformaat, de gemaakte keuzes en de open punten |
| [`poc/selection-probe/`](poc/selection-probe/) | Meetinstrument: kan een Edge-extensie uitlezen welke formulieren zijn aangevinkt? |

## Eerst dit

De tool leunt erop dat de extensie de selectie uit de ACC-UI kan lezen. Dat is
niet gedocumenteerd en niet gegarandeerd. `poc/selection-probe` stelt vast of het
kan en langs welke route — zie de README daar. Tot die uitkomst binnen is, staat
de rest van de bouw stil.
