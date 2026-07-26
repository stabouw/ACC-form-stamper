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

Het stempel deelt de beschikbare ruimte met de bewaarde gebruikersnotities. Bij
overschrijding, in deze volgorde:

1. Volledig formaat.
2. Bovenliggende categorieën weglaten, alleen het laatste niveau:
   `asset A (24), asset B (23)`.
3. Lijst inkorten en afsluiten met `(+7 meer)`.

Bevestigd in de referentie: `notes` heeft `Max length: 8000`. Het stempel gaat in
`notes` — niet in `description`, dat een eigen veld met dezelfde grens is.

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
   Relationship API (`relationships:intersect`, batches van maximaal 20),
   daarna assetnamen en categorie-id's via `GET assets`, en categorie-id's naar
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
| Forms-API | v2 voor het ophalen; v1 voor de `PATCH`, want daar is geen v2 van |
| Stempelveld | `notes` (max 8000), niet `description` |

### Waarom gesloten formulieren standaard uit staan

Gesloten formulieren zijn niet te bewerken, maar kunnen met de juiste rechten
heropend, aangepast en opnieuw gesloten worden. Bij dat opnieuw sluiten worden
"gesloten door" en "gesloten op" hoogstwaarschijnlijk overschreven met de
uitvoerende gebruiker en de datum van vandaag. Het stempelen zelf is
onschuldig; het herschrijven van die historie over honderden formulieren is dat
niet. Vandaar een expliciete keuze per run.

## Open punten

Zie `api-notes.md` voor de API-kant in detail. In het kort:

- **Kan een gesloten formulier via de API heropend worden?** Het ontwerp gaat
  ervan uit van wel. De referentie zegt dat gesloten formulieren "no longer
  editable" zijn, zonder te vermelden of dat ook voor het statusveld zelf geldt.
  Werkt het niet, dan vervalt de hele optie "gesloten formulieren meenemen" —
  en daarmee ook de zorg hieronder over "gesloten door". Eén testformulier
  volstaat om dit te beslissen.
- **Ongedaan maken en status.** Zet een terugdraaiactie ook de status terug, of
  alleen de notities?
- **Tekst onder de markering.** Typt een gebruiker iets ónder het blok, dan gaat
  dat verloren bij de volgende run. Bewust geaccepteerd, maar het hoort in de
  gebruikersuitleg.

Afgevallen: de **richting van de relatiezoekopdracht** is geen open punt meer.
De relatieservice is bi-directioneel en de zoekparameters zijn symmetrisch, dus
formulier → assets werkt net zo goed als andersom. De omgekeerde index als
terugvaloptie is niet nodig.

Ook bevestigd: `notes` is patchbaar via `PATCH` met `projectId` + `templateId` +
`formId` — dat doet `BatchFormCreator` in productie, en de referentie bevestigt
de route. De schrijfactie zelf is daarmee geen risico meer.

**We bouwen op Forms v2.** Let op dat v2 alleen `GET forms` en
`PUT values:batch-update` dekt — de `PATCH` waarmee wij schrijven, bestaat alleen
in v1. De tool gebruikt dus beide versies naast elkaar, en de statuswaarden
verschillen ertussen (`inProgress` bij het lezen, `draft` bij het schrijven).
Zie `api-notes.md` voor de vertaaltabel.
