# Ontwerpbesluiten bij de handoff

Het ontwerp in [`design_handoff_form_stamper/`](design_handoff_form_stamper/)
tekent vier schermen in hun geslaagde toestand. Het proces uit
[`workflow.md`](workflow.md) kent meer toestanden dan dat. Dit document legt vast
wat er met dat verschil gebeurt.

De handoff zelf blijft ongewijzigd — dat is een stuk van het ontwerpteam. Wat
hieronder staat, is wat de bouw doet waar de handoff zwijgt.

## 1. "Terug" op Selecteren meldt af

Aanmelden blijft stap 1 van 4, ook al ziet een terugkerende gebruiker dat scherm
nooit. De ghost-knop "Terug" op Selecteren gaat naar Inloggen en is daarmee de
afmeldroute. Dat is bewust: wie is aangemeld, moet zich ook kunnen afmelden, en
een tweede plek daarvoor is er niet.

## 2. Geen apart Verrijken-scherm

Het ophalen van de gekoppelde assets gaat in blokken van maximaal 20
(`INTERSECT_MAX_ENTITIES`). Die blokken vullen de tabel op Selecteren terwijl ze
binnenkomen; er komt geen tussenscherm. Bij een selectie van honderd formulieren
ziet de gebruiker de eerste twintig rijen dus al staan terwijl de rest nog loopt.

## 3. Gesloten formulieren zijn zichtbaar vóór het stempelen

De status van een formulier komt uit `GET forms` en is dus bekend op Selecteren.
Hij hoort daar dan ook te staan, niet pas als fout tijdens het stempelen zoals
`03b-stempelen-fout.html` het tekent.

- Een gesloten formulier krijgt een **gele status-pill onder de formuliernaam**.
- De schakelaar "Ook gesloten formulieren" **verschijnt alleen als er gesloten
  formulieren in de selectie zitten**, en noemt het aantal. Staan ze er niet, dan
  is de schakelaar er ook niet — de handoff tekent hem met "0 gesloten
  formulieren", en die toestand bestaat niet meer.

De onomkeerbaarheid ("gesloten door" en "gesloten op" worden overschreven, zie
[`workflow.md`](workflow.md)) hoort als uitleg bij die schakelaar te staan.

## 4. Geen gekoppelde assets is een waarschuwing, geen overslaan

Een formulier zonder gekoppelde assets krijgt een **gele waarschuwing in de
kolom "Gekoppelde assets"**.

Belangrijk: dit betekent **niet** dat het formulier overgeslagen wordt. Had het
formulier eerder wél assets in zijn notities staan, dan is de assetregel nu
verouderd en moet die juist bijgewerkt worden naar leeg. Alleen een formulier
dat geen assets heeft én geen assetregel in zijn notities, is werkelijk niets te
doen.

## 5. "Limiet" is twee verschillende uitkomsten

`buildStampedNotes` in [`../src/stamp.js`](../src/stamp.js) kan twee dingen
opleveren die de handoff onder één `limiet`-tag vangt:

| Uitkomst | Betekenis | Wat er gebeurt |
|---|---|---|
| `fits: true`, `shown < total` | Paden ingekort, of de lijst afgekapt met `(+N meer)` | Wordt geschreven |
| `fits: false` | Zelfs één asset past niet meer — de gebruikerstekst vult de 8000 al | Er wordt **niets** geschreven |

Die tweede moet op Selecteren als zodanig te zien zijn. Een voorbeeldscherm dat
niet laat zien dat een formulier geweigerd gaat worden, doet zijn werk niet.

## 6. Tekst onder de markering: melden achteraf

Typt iemand tekst ónder het assetblok, dan gooit `splitNotes` die weg. Dat is in
[`workflow.md`](workflow.md) bewust geaccepteerd en komt zelden voor.

Het wordt daarom niet vooraf gesignaleerd, maar **achteraf per formulier
gemeld** op Stempelen — op de regel van dat formulier, zoals `03b` dat ook doet
met "Notities bijgewerkt, ingekort naar limiet". Vooraf waarschuwen voor iets dat
bijna nooit gebeurt, kost meer aandacht dan het waard is.

## 7. PDF-formulieren doen gewoon mee

De referentie van Autodesk zegt dat PDF-formulieren niet bij te werken zijn. Dat
is op 27-07-2026 gemeten en **het klopt niet**: schrijven, teruglezen en
terugzetten slaagden alle vier de stappen. Zie
[`api-notes.md`](api-notes.md#pdf-formulieren-zijn-gewoon-te-stempelen).

Er wordt dus **niets gefilterd** en er komt geen uitgeschakelde rij, geen
"PDF"-signaal en geen aparte telling. Een PDF-formulier is voor deze tool een
formulier als alle andere. Dat scheelt een tabelkolom, een tag en een uitleg.

Het onderscheid is wel te máken (`pdfFile` tegenover `nativeForm`), maar wordt
alleen bewaard voor de uitleg over **Filters → Opmerkingen**: bij een
PDF-formulier is het notitieveld per definitie niet op het formulier zelf te
zien, en dat is precies de verwarring die die regel moet wegnemen.

## 8. Token verloopt tijdens een run

De run pauzeert, de gebruiker meldt zich opnieuw aan, de run gaat verder waar hij
was. Stempelen kent daarvoor nu geen toestand: drie bolletjes (klaar, wachtend,
fout) en geen vierde voor "gepauzeerd", en geen route van stap 3 naar Inloggen en
weer terug.

**Herkennen.** `ApsError` draagt al een `needsSignIn`-vlag, en de service worker
geeft die mee in elk foutantwoord. Een fout met die vlag is dus te onderscheiden
van een gewone formulierfout, en dat is precies het verschil dat telt: een
verlopen aanmelding is niet de schuld van dít formulier.

**Gedrag: terug naar stap 1.** Waar het ook gebeurt — bij het verrijken, tijdens
een run, of bij het terugdraaien — een dode aanmelding stuurt de gebruiker naar
Inloggen, met een regel erbij over wat er al gedaan was.

Een eerdere versie van dit punt liet de run ter plekke pauzeren en na het
opnieuw aanmelden hervatten. Dat is bij het bouwen gesneuveld, om twee redenen:

1. **Het kán niet.** Aanmelden opent een venster van Autodesk. De popup verliest
   daarmee de aandacht, en een browser-popup die de aandacht verliest sluit. De
   halve uitvoering stond alleen in het geheugen van die popup en is dan weg.
   Een pauzescherm dat je nooit terugziet, is geen pauzescherm.
2. **Het hoeft niet.** Het stempel is idempotent: een formulier waarvan de
   assetregel al klopt, levert "ongewijzigd" op en wordt overgeslagen. Opnieuw
   beginnen ís dus hervatten. En omdat het journaal per formulier wordt
   weggeschreven, blijft alles wat al geschreven was gewoon terug te draaien.

De tweede reden is de belangrijkste: er is hier niets te bewaren, dus is er ook
niets te herstellen. Dat de eerste reden het sowieso onmogelijk maakte, kwam er
pas bij.

**Hoe vaak dit voorkomt: bijna nooit.** Zie hieronder.

**Gevolg voor het journaal.** Dit dwingt een keuze af die anders pas laat
opvalt: het journaal moet **per formulier bijgewerkt worden, direct na elke
schrijfactie** — niet in één keer aan het eind van de run. Pauzeert een run en
komt de gebruiker nooit terug, dan zijn er wél formulieren gestempeld, en die
moeten terug te draaien zijn. Een journaalregel die pas bij "klaar" wordt
weggeschreven, bestaat op dat moment niet.

Datzelfde geldt voor "Annuleren" halverwege, dus het is geen extra eis van dit
geval alleen. Vastgelegd in `journaal.test.js`.

## 9. Aanmelden is eenmalig, niet per sessie

De tokens staan in `chrome.storage.local` en overleven het sluiten van de popup,
het sluiten van de browser, en een herstart van de computer. Het is dus geen
sessiegeheugen: wie één keer aanmeldt, blijft aangemeld.

| | |
|---|---|
| Autorisatiecode | 5 minuten |
| Access token | 60 minuten |
| Refresh token | 15 dagen |

Het access token van een uur is nooit iets dat de gebruiker merkt:
`getAccessToken()` vernieuwt het stilletjes zodra het binnen vijf minuten
verloopt, midden in een run desnoods.

Het refresh token van vijftien dagen wordt bij elke vernieuwing vervangen door
een nieuwe met een nieuwe termijn. **Wie de tool minstens eens per twee weken
gebruikt, ziet het inlogscherm nooit meer.** Dat maakt punt 8 een randgeval en
geen dagelijkse hinder — het treft alleen wie de tool twee weken laat liggen, of
wiens toegang is ingetrokken.

Korter dan vijftien dagen kan niet opgerekt worden; dat is een grens van
Autodesk, niet van ons.

## 10. Geen bovengrens aan de selectie

Forma Build toont 50 formulieren per pagina, maar de selectie loopt daar dwars
doorheen: aanvinken op meerdere pagina's stapelt op. Waargenomen met 200
formulieren over vier pagina's, die alle 200 in het paneel terechtkwamen. Er is
dus niets te begrenzen en niets over uit te leggen.

Tussendoor is hier een 50-grens ingebouwd — een gele melding bij de teller, een
`PAGINAGROOTTE`-constante, aangepaste documentatie op vijf plekken — op grond van
één waarneming dat doorbladeren de selectie leeg leek te gooien. Dat klopte niet,
en het is allemaal weer weg.

Het waard om te onthouden: `api-notes.md` had dit correct staan als
gevolgtrekking, met de eerlijke kanttekening dat het niet gemeten was. Die
kanttekening is toen behandeld als "dus waarschijnlijk fout" in plaats van "dus
nog te controleren". Eén tegenstrijdige waarneming is geen meting, en documentatie
omgooien is duurder dan even nakijken.

## Wat er bij het bouwen nog uit kwam

Drie dingen die pas zichtbaar werden toen het draaide, en die geen van drieën
uit het ontwerp af te lezen waren.

**Een formulier zonder assets kreeg "nieuw".** `stampChanged` ziet geen markering
in de huidige notities, noemt dat een wijziging, en dan zou de tool een lege
assetregel onder een markering schrijven op een formulier dat helemaal geen
assets heeft — het lege-lijst-geval uit `ux-brief.md`. Nu een uitzondering
bovenaan `bepaalUitkomst`: geen assets én nooit gestempeld is niets te doen.

**Opnieuw proberen telde dubbel.** Een formulier dat eerst faalde en daarna
slaagde, kreeg twee journaalregels — één als fout, één als geschreven. Dat maakt
de telling onjuist en zou bij het terugdraaien hetzelfde formulier twee keer
aanpakken. De journaalregel wordt nu vervangen op `formId`, niet toegevoegd.

**Lege uitvoeringen verdrongen echte.** Wie het paneel opent en weer weggaat,
maakt een uitvoering zonder formulieren. Twintig daarvan en de laatste
terugdraaibare run is uit het journaal verdwenen. Ze worden nu opgeruimd bij het
starten van een nieuwe.

## Wat de bouw aanhoudt waar de mockup afwijkt

Kleine dingen waar de getekende schermen niet met elkaar of met de code
overeenkomen. Leidend is de code, want die schrijft de werkelijke tekst.

- **Categoriescheiding is ` > `, niet `->`.** De mockup toont
  `Pomp 3 (1->Ba->24)`; [`../src/stamp.js`](../src/stamp.js) legt ` > ` vast omdat
  ACC de categorie zelf ook zo toont.
- **`(+N meer)` is geen UI-afkorting.** Het is de afkapmarkering uit de
  8000-tekenladder. De kolom "Gekoppelde assets" moet zijn eigen manier van
  inkorten hebben, anders lijkt een lange lijst op een afgekapt stempel.
- **Formuliernummering.** De mockup nummert `#1`–`#4` op Selecteren, `#0`–`#3` op
  Stempelen, en helemaal niet op `03b`. Aanhouden: `formNum` uit het
  formulierrecord, overal hetzelfde.
- **Verplichte uitleg ontbreekt.** De regel over **Filters → Opmerkingen** staat
  op geen enkel scherm, terwijl [`ux-brief.md`](ux-brief.md) hem verplicht stelt
  op zowel het voorbeeld als het resultaat. Zonder die regel kijkt de gebruiker
  op een formulier zonder zichtbaar notitieblok, ziet niets, en stempelt nog een
  keer.
