# ACC Form Stamper — workflow

## Waarom

In Forma Build kun je formulieren niet filteren op assetnaam of assetcategorie.
Wat wél doorzoekbaar is, is het notitieveld van een formulier. Door de gekoppelde
assets in dat veld te zetten, worden formulieren alsnog vindbaar per asset en per
categorie.

De bestaande Power Automate-flow `BatchFormCreator` doet dit al bij het *aanmaken*
van nieuwe formulieren. Deze tool doet hetzelfde voor formulieren die er al staan.

## Het stempel

De notities worden opgebouwd als: bestaande tekst van de gebruiker → lege regel →
markeringsregel → machinegedeelte.

```
Controle uitgevoerd op 12-3, klep vervangen.

--- gekoppelde assets (26-07-2026) ----
asset A (1->Ba->24), asset B (1->Ba->23)
```

Regels:

- Eén item per gekoppelde asset: `<assetnaam> (<volledig categoriepad>)`.
  Padsegmenten met `->`, items met `, `.
- Assets in een vaste volgorde (op naam), zodat herhaald draaien dezelfde string
  oplevert.
- Alles bóven de markering is van de gebruiker en wordt nooit aangeraakt. Alles
  eronder is van de tool en wordt in zijn geheel vervangen.
- `BatchFormCreator` wordt aangepast naar exact dit formaat, zodat nieuwe en
  bijgewerkte formulieren niet van elkaar te onderscheiden zijn voor een filter.

### Limiet van 8000 tekens

Het stempel deelt de 8000 tekens met de bewaarde gebruikersnotities. Bij
overschrijding, in deze volgorde:

1. Volledig formaat.
2. Bovenliggende categorieën weglaten, alleen het laatste niveau:
   `asset A (24), asset B (23)`.
3. Lijst inkorten en afsluiten met `(+7 meer)`.

### Datum in de markering

De markering bevat een datum, dus:

- Herkenning gaat via een patroon (`--- gekoppelde assets (dd-MM-jjjj) ----`),
  niet via een letterlijke vergelijking.
- Of iets verouderd is, wordt bepaald op de **assetregel alleen**, niet op de
  datum. Anders lijkt elk formulier de dag erna verouderd.
- Is de assetregel ongewijzigd, dan wordt er niets geschreven. Geen API-call,
  geen wijziging van "laatst gewijzigd door". De datum betekent daarmee
  *wanneer de assetinformatie is vastgelegd*, niet *wanneer de tool voor het
  laatst draaide*.

## Stappen

1. **Selectie** — de gebruiker vinkt formulieren aan in ACC Build zelf; de
   extensie leest die selectie. Zie `poc/selection-probe` — dit moet eerst
   bewezen worden.
2. **Verrijken** — per formulier de gekoppelde assets ophalen via de
   Relationship API, daarna assetnamen en categorie-id's, en categorie-id's naar
   volledige paden via de eenmalig opgehaalde categorieboom.
3. **Voorbeeld** — tabel `formulier → huidige notities → voorgestelde notities`,
   met de gewijzigde regio gemarkeerd. Er is nog niets geschreven. Formulieren
   die tegen de 8000 tekens aanlopen worden apart benoemd.
4. **Uitvoeren** — per formulier: (heropenen indien gesloten) → `PATCH` notities
   → (weer sluiten). Fouten stoppen de run niet, maar komen in een lijst die
   opnieuw geprobeerd kan worden.
5. **Journaal en ongedaan maken** — vóór elke schrijfactie worden de oude
   notities en de oude status vastgelegd, zodat een run teruggedraaid kan worden.

## Beslissingen

| Onderwerp | Keuze |
|---|---|
| Selectie | Expliciet aanvinken, in de ACC-UI zelf |
| Uitvoering | Op verzoek, geen planning |
| Notities | Afgeschermd blok; tekst van de gebruiker blijft staan |
| Inhoud stempel | Assetnaam + volledig categoriepad. Geen locatie — daar kan Forma Build al op filteren |
| Gesloten formulieren | Per run aan te zetten, standaard uit, met bevestiging van het aantal |
| Auth | 3-legged (PKCE), eigen APS-app |
| Client | Edge-extensie |

### Waarom gesloten formulieren standaard uit staan

Gesloten formulieren zijn niet te bewerken, maar kunnen met de juiste rechten
heropend, aangepast en opnieuw gesloten worden. Bij dat opnieuw sluiten worden
"gesloten door" en "gesloten op" hoogstwaarschijnlijk overschreven met de
uitvoerende gebruiker en de datum van vandaag. Het stempelen zelf is
onschuldig; het herschrijven van die historie over honderden formulieren is dat
niet. Vandaar een expliciete keuze per run.

## Open punten

Zie `api-notes.md` voor de API-kant in detail. In het kort:

- **Richting van de relatiezoekopdracht.** `BatchFormCreator` zoekt vanaf de
  asset (`domain=autodesk-bim360-asset`). Wij hebben de omgekeerde richting
  nodig. Werkt dat niet, dan bouwen we eenmalig een index asset → formulieren
  en draaien we die om. Moet geverifieerd worden.
- **API-details onbevestigd.** Statuswaarden, de endpoints voor
  statusovergangen, scope-namen, de assets- en categorieën-endpoints en de
  8000-tekengrens zijn niet tegen de documentatie gecontroleerd; die was niet
  bereikbaar vanuit de ontwikkelomgeving.
- **Ongedaan maken en status.** Zet een terugdraaiactie ook de status terug, of
  alleen de notities?
- **Tekst onder de markering.** Typt een gebruiker iets ónder het blok, dan gaat
  dat verloren bij de volgende run. Bewust geaccepteerd, maar het hoort in de
  gebruikersuitleg.

Wél al bevestigd: `notes` is patchbaar via `PATCH` met
`projectId` + `templateId` + `formId` — dat doet `BatchFormCreator` in
productie. De schrijfactie zelf is daarmee geen risico meer.
