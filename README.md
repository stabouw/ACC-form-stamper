# ACC Form Stamper

Zet de gekoppelde assets van een ACC-formulier in het opmerkingenveld van dat
formulier, zodat formulieren in Forma Build alsnog te filteren zijn op assetnaam
en assetcategorie — iets wat de Forms-module zelf niet kan.

In de API heet dat veld `notes`; in de Nederlandse interface van ACC heet het
**Opmerkingen**. De tool gebruikt overal het woord dat de gebruiker op zijn
scherm ziet.

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

**Aangemeld en selecteren werken tegen een echt project.** Stap 1 en 2 zijn
gedraaid op `HI_PR_KNM-test`, met selecties tot 200 formulieren over meerdere
pagina's. Het uitlezen van de selectie, het verrijken in blokken van 20 en de
statusbepaling per formulier doen wat ze moeten doen.

**Nog niet gedaan: een echte stempelrun op schaal.** Stap 3 en 4 zijn getest met
losse formulieren en met 31 geautomatiseerde tests, niet met een batch van
vijftig tegen een echt project.

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
| [`docs/INSTALLEREN.md`](docs/INSTALLEREN.md) | Handleiding voor de gebruiker — geef deze mee met het zipbestand |
| [`tools/make-icons.mjs`](tools/make-icons.mjs) | Tekent het extensie-icoon. Chrome wil bitmaps; dit is de bron ervan |
| [`tools/package.mjs`](tools/package.mjs) | Maakt het uitdeelpakket, en controleert eerst of key en callback-URL kloppen |
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

## Uitdelen aan collega's

```
node tools/package.mjs
```

Levert `dist/acc-form-stamper-<versie>.zip`. Geef die mee met
[`docs/INSTALLEREN.md`](docs/INSTALLEREN.md) — dat is de handleiding voor de
gebruiker, zonder ontwikkelaarsdetails.

Het zipbestand bevat `installeren.cmd`, een `extensie/`-map en een kort
`LEES DIT EERST.txt`. De gebruiker draait het script; dat zet de extensie in
`C:\_Data\Heijmans\ACC-Form-Stamper` en legt uit hoe hij hem eenmalig in Edge
laadt.

Die vaste plek is er niet voor de netheid. Edge laadt een uitgepakte extensie
elke keer opnieuw vanaf zijn map, dus een extensie die in Downloads blijft staan
verdwijnt zodra iemand opruimt. Bijwerken gaat bovendien alleen goed als de
nieuwe versie op dezelfde plek komt: laadt Edge hem vanaf een ander pad, dan is
het voor hem een andere extensie en zijn de aanmelding en het journaal weg.

Het script komt uit [`tools/installeren.cmd.template`](tools/installeren.cmd.template);
`package.mjs` vult de doelmap en het versienummer in, zodat die op één plek
vastliggen.

### De client id is geen geheim, het extensie-id is het probleem

De APS-app is een **publieke client** (PKCE, geen client secret). De client id
staat gewoon in [`src/config.js`](src/config.js) en bij elke aanmelding in de
adresbalk. Die mag rondgaan.

Wat wél kritiek is, is het **`key`-veld in de manifest**. Dat legt het extensie-id
vast, en dat id bepaalt de callback-URL:

```
key (manifest) → extensie-id → https://<id>.chromiumapp.org/
```

Alleen die ene URL staat bij Autodesk geregistreerd. Haal je de key weg, of
vervang je hem, dan krijgt de extensie op elke machine een ander id, klopt de
callback niet meer, en mislukt het aanmelden met "invalid redirect_uri" — een
melding die niets zegt over de werkelijke oorzaak.

Daarom rekent `tools/package.mjs` het extensie-id uít de key uit en legt het naast
`EXPECTED_REDIRECT_URI` in `config.js`. Lopen ze uiteen, dan pakt het script niets
in. De extensie doet dezelfde controle bij het aanmelden, via `assertRedirectUri()`.

Omdat de client id aan die ene callback-URL vastzit, kan iemand er buiten deze
extensie weinig mee.

### Wat dit betekent voor publiceren in een store

Dit werkt zolang je **uitgepakt laadt**. Publiceer je naar de Edge Add-ons- of
Chrome Web Store, dan geeft de store de extensie zijn eigen id, en dan klopt de
geregistreerde callback-URL niet meer. Dat is geen blokkade, maar wel werk: de
nieuwe callback-URL moet dan bij de APS-app geregistreerd worden en `config.js`
moet mee.

### Toegang tot het ACC-account

Elke gebruiker meldt zich met zijn eigen account aan en werkt met zijn eigen
rechten — installeren geeft niemand toegang die hij nog niet had.

Wel moet de APS-app één keer per ACC-account goedgekeurd zijn door een
accountbeheerder (**Account Admin → Custom Integrations**, op client id). Zonder
dat lukt het aanmelden wel, maar geven de aanroepen een 403. Zitten je collega's
in hetzelfde ACC-account als waar dit is gebouwd, dan is dat al geregeld.

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

**De selectie overleeft het doorbladeren.** 200 formulieren, opgebouwd over vier
pagina's van 50, kwamen alle 200 binnen. Er is dus geen bovengrens.

Dat is drie van de drie: elke ongedocumenteerde beperking waar we op zijn gaan
meten, viel bij meting de andere kant op. Waard om te onthouden bij de volgende.

Eén waarschuwing daarbij, uit eigen ervaring. Het punt over doorbladeren is
onderweg één keer de verkeerde kant op gezet, op grond van één waarneming, en
daarvoor is de documentatie op vijf plekken omgegooid — om het daarna weer terug
te draaien. Een aanname met een eerlijke kanttekening erbij ("nog niet gemeten")
is iets om ná te kijken, niet iets om vast aan te nemen dat het fout is. Eén
tegenstrijdige waarneming is geen meting.

Alle metingen staan met hun uitkomst in [`docs/api-notes.md`](docs/api-notes.md).

## Volgende stappen

1. **Een echte stempelrun draaien.** Stap 3 en 4 zijn nog niet op schaal
   gedraaid. Doe een run van tien à twintig formulieren op een testproject, draai
   hem terug, en kijk of het journaal klopt met wat er in ACC staat. Neem er een
   gesloten formulier in mee, want dat is de enige route met een onomkeerbare
   kant.
2. **`BatchFormCreator` gelijktrekken** met het stempelformaat, zodat nieuwe en
   bijgewerkte formulieren niet van elkaar te onderscheiden zijn voor een filter.
3. **Uitzoeken of `include=layoutInfo` per sjabloon vertelt of het
   opmerkingenblok aan staat.** Zo ja, dan kan de vaste uitleg over
   Filters → Opmerkingen een signaal per rij worden — preciezer dan de algemene
   tekst die er nu op stap 4 staat.
4. **De volgorde van formulieren buiten de huidige pagina.** De tabel neemt de
   sortering van ACC over, maar alleen voor de 50 rijen die de pagina vasthoudt;
   de rest komt erachteraan. Het content script geeft de sorteerstand al mee, dus
   dat is af te maken zodra het stoort.

Vóór dit tegen een echt project draait: `PROBE_CONFIRM_DEFAULT` in
[`src/background.js`](src/background.js) staat op `true` omdat er op
testprojecten gemeten wordt. Terugzetten op `false`.
