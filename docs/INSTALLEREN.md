# Form Stamper installeren

Deze extensie zet de gekoppelde assets van een formulier in het veld
**Opmerkingen**, zodat je in Forma Build alsnog op assetnaam en assetcategorie
kunt filteren — iets wat de Formulieren-module zelf niet kan.

Je hebt nodig: Microsoft Edge, het zipbestand, en een Autodesk-account met
toegang tot het project waar je mee werkt.

---

## 1. Uitpakken en installeren

Pak het zipbestand uit — waar maakt niet uit, Downloads is prima — en dubbelklik
op **`installeren.cmd`**.

Het script vraagt of je door wilt gaan en zet de extensie daarna op een vaste
plek:

```
C:\_Data\Heijmans\ACC-Form-Stamper
```

Dat het niet in Downloads blijft staan, heeft een reden: Edge laadt de extensie
elke keer opnieuw vanaf de map waar hij staat. Ruim je Downloads op, dan is de
extensie weg uit je browser. Op deze vaste plek gebeurt dat niet.

De uitgepakte zipmap mag je daarna weggooien.

## 2. Laden in Edge

Eenmalig, na de eerste installatie:

1. Ga naar `edge://extensions` (typ dat in de adresbalk).
2. Zet linksonder **Ontwikkelaarsmodus** aan.
3. Klik op **Uitgepakt laden**.
4. Kies `C:\_Data\Heijmans\ACC-Form-Stamper`.

Het installatiescript biedt aan die map voor je te openen, dan kun je hem in
stap 4 zo aanwijzen.

De extensie verschijnt in de lijst. Klik op het puzzelstukje rechts in de
werkbalk en zet Form Stamper vast, dan staat het icoon altijd binnen bereik.

Edge kan bij het opstarten vragen of je extensies in ontwikkelaarsmodus wilt
blijven gebruiken. Zeg ja — anders staat de extensie uit.

## 3. Aanmelden

1. Open in Forma Build het **formulieroverzicht** van je project.
2. Klik op het Form Stamper-icoon.
3. Klik op **Inloggen bij Autodesk**.

Er opent een venster van Autodesk. Meld je aan met je gewone Autodesk-account.

Dat je nog een keer moet inloggen terwijl je al in ACC zit, is niet dubbelop: de
extensie werkt namens jou en met jouw rechten. Wat jij niet mag wijzigen, wijzigt
de extensie ook niet.

**Dit is eenmalig.** Zolang je de extensie minstens eens per twee weken gebruikt,
blijf je aangemeld — ook na het afsluiten van je browser of je computer.

---

## Gebruiken

De extensie werkt in vier stappen.

**1 — Inloggen.** Zie hierboven. Zie je dit scherm niet, dan ben je al aangemeld.

**2 — Selecteren.** Vink in Forma Build zelf de formulieren aan die je wilt
stempelen. Filter en zoek zoals je gewend bent; de extensie kijkt mee. Klik dan
op het icoon en je ziet per formulier wat er gaat gebeuren:

| | |
|---|---|
| **nieuw** | Er komt een assetregel bij waar nog niets stond |
| **bijgewerkt** | De bestaande assetregel wordt aangepast |
| **ongewijzigd** | Klopt al — er wordt niets geschreven |
| **past niet** | De opmerkingen zitten al aan de 8000 tekens; er wordt niets geschreven |

Je selectie blijft staan als je doorbladert, dus je kunt over meerdere pagina's
aanvinken.

Er is nog niets gewijzigd op dit scherm. Klopt het beeld, klik dan op
**Stempelen**.

**3 — Stempelen.** De formulieren gaan één voor één langs. Je ziet per formulier
of het gelukt is. Gaat er één mis, dan stopt de rest niet; achteraf kun je alleen
die ene opnieuw proberen.

**4 — Samenvatting.** Een overzicht van je vorige uitvoeringen, elk met een knop
**Ongedaan maken** die de opmerkingen terugzet zoals ze waren.

---

## Goed om te weten

**Handgeschreven tekst blijft staan.** Alles wat jij zelf in de opmerkingen hebt
getypt, blijft staan. De extensie beheert alleen het blok onder de regel
`--- gekoppelde assets (datum) ----`. Typ je iets ónder dat blok, dan raak je dat
bij de volgende ronde kwijt — zet je eigen tekst er dus bóven.

**Het veld is niet altijd zichtbaar.** Afhankelijk van het formuliersjabloon staat
Opmerkingen niet op het formulier zelf. Je vindt de formulieren dan wél terug via
**Filters → Opmerkingen** in het overzicht. Dat is ook precies waar het om
begonnen was.

**Gesloten formulieren.** Die kunnen mee, maar alleen als je dat per keer
aanzet — en er zit een prijs aan. Bij het opnieuw sluiten komen jouw naam en de
datum van vandaag te staan als wie het formulier heeft afgerond, en **dat is niet
terug te draaien**, ook niet met Ongedaan maken. De schakelaar verschijnt alleen
als er gesloten formulieren zijn waar het verschil maakt.

**Alles is terug te draaien** — behalve dat ene hierboven. Elke uitvoering
bewaart de oude opmerkingen, ook als je halverwege stopt.

---

## Als er iets niet werkt

**"Open het formulierenoverzicht van Forma Build…"**
Je staat op een andere pagina. Ga naar de formulierenlijst van je project en klik
opnieuw op het icoon.

**Het icoon is verdwenen na een herstart**
Edge heeft de extensie uitgezet omdat hij in ontwikkelaarsmodus draait. Ga naar
`edge://extensions` en zet hem weer aan. Staat hij er helemaal niet meer, dan is
`C:\_Data\Heijmans\ACC-Form-Stamper` verplaatst of verwijderd — draai
`installeren.cmd` opnieuw.

**"kopieren is niet gelukt" bij het installeren**
Geen schrijfrechten op `C:\_Data`, of de map staat open in een ander venster.
Sluit Verkenner-vensters die in die map staan en probeer het opnieuw. Blijft het
misgaan, geef dan de foutcode door die het script noemt.

**"Inloggen mislukt"**
Meestal een afgebroken of weggeklikt aanmeldvenster. Probeer het opnieuw. Blijft
het misgaan, geef dan door wat er precies in het rode balkje staat.

**Je ziet formulieren die je niet mag wijzigen**
De extensie werkt met jouw rechten. Een formulier waar jij niet aan mag komen,
levert een fout op die rij op en verder niets.

**Er gaat iets mis dat hier niet staat**
Geef door: wat je aan het doen was, wat er op het scherm stond, en om welk project
het ging. Zit er een foutmelding bij, dan is die het nuttigst.

---

## Bijwerken

Komt er een nieuwe versie, dan krijg je een nieuw zipbestand:

1. Pak het uit en dubbelklik weer op **`installeren.cmd`**.
2. Ga naar `edge://extensions` en klik op **Vernieuwen** bij Form Stamper.

Meer niet — je hoeft niet opnieuw **Uitgepakt laden** te doen, want de extensie
staat nog op dezelfde plek.

Je blijft aangemeld en je overzicht van vorige uitvoeringen blijft staan. Dat
komt doordat de nieuwe versie op precies dezelfde plek terechtkomt; laad je hem
vanaf een andere map, dan ziet Edge het als een andere extensie en begin je met
een lege lijst.
