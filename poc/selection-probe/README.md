# Selectie probe — PoC

Doel: vaststellen **of** en **hoe** een Edge-extensie kan lezen welke formulieren
de gebruiker in ACC Build heeft aangevinkt. Dit is een meetinstrument, geen
product — het schrijft niets weg en verandert niets in ACC.

Zolang dit niet werkt, heeft de rest van de tool geen zin. Daarom eerst dit.

## Laden in Edge

1. Open `edge://extensions`.
2. Zet **Ontwikkelaarsmodus** aan (schakelaar linksonder).
3. Klik **Uitgepakt laden** en kies de map `poc/selection-probe`.
4. Open ACC Build → Formulieren, in een project met een paar formulieren.
5. Rechtsonder verschijnt het paneel *Selectie probe*.

Als het paneel niet verschijnt: controleer of de URL `acc.autodesk.com` of
`acc.autodesk.eu` is. Staat ACC bij jullie op een ander domein, dan moeten die
hosts in `manifest.json` bij `host_permissions` én `content_scripts.matches`.

## Wat te doen

**Meting 1 — selectie**

1. Vink 2 tot 3 formulieren aan in de lijst.
2. Klik **Probe selectie**.
3. Klik **Kopieer rapport** en plak het terug in de chat.

**Meting 2 — netwerk**

1. Herlaad de formulierenpagina volledig (F5) — de netwerk-hook moet actief zijn
   vóórdat de app laadt.
2. Wacht tot de lijst gevuld is, blader eventueel een pagina verder.
3. Klik **Netwerk log** → **Kopieer rapport** → plak terug in de chat.

Doe meting 1 zowel met als zonder selectie, dan is het verschil zichtbaar.

## Wat er in het rapport staat

Het rapport beschrijft **vormen, geen inhoud**. Strings langer dan 24 tekens
worden vervangen door hun lengte, GUID's door het woord `GUID`, en GUID's in
URL's door `<GUID>`. Er staan dus geen formuliernamen, projectnamen of
persoonsgegevens in. Loop het gerust even na voordat je het deelt.

Waar het rapport op uit is:

- `checkedCheckboxes` / `ariaSelected` / `ariaChecked` — welk mechanisme ACC
  gebruikt om selectie in de DOM te markeren, en of daar bruikbare attributen
  bij zitten.
- `reactFiber` — de interessantste. ACC Build is React; DOM-knopen dragen
  `__reactProps$…` en `__reactFiber$…` eigenschappen waarin de onderliggende
  rij-data zit. Als hier paden met GUID's uit komen, dan is dát de route naar
  de formulier-id, en die is een stuk stabieler dan CSS-klassen. Vermoedelijk
  is dit ook hoe je collega het voor elkaar heeft gekregen.
- `getRequests` — welke API-calls de pagina zelf doet en of de antwoorden
  GUID's bevatten. Als de lijst via een aanroep binnenkomt die we kunnen
  meelezen, hebben we de id's zonder de DOM aan te raken.

## Hoe dit verder gaat

Op basis van de uitkomst kiezen we de leesroute voor de echte extensie:

1. **React props** — waarschijnlijk het meest werkbaar.
2. **Netwerk meelezen** + rij-index koppelen aan selectie.
3. **DOM-attributen** — alleen als er iets stabiels blijkt te zijn.
4. **Geen van drie** — dan bouwt de extensie zijn eigen lijst op de publieke
   Forms API, en vervalt de koppeling met de ACC-selectie.

Wat de uitkomst ook is, het stempelen zelf loopt via de gedocumenteerde
publieke API's. Alleen het uitlezen van de selectie hangt van deze meting af,
en dat blijft bewust één klein, vervangbaar stukje code.
