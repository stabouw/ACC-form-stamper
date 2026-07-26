# API-aantekeningen

Verzamelde kennis over de APS/ACC-kant. **Let op de herkomst per regel**: een
deel is afgeleid uit een draaiende Power Automate-flow en dus bewezen, een deel
komt uit de officiële referentie, een deel is nog aanname.

De Autodesk-documentatie is inmiddels wél bereikbaar — de 403 gold alleen
`aps.autodesk.com`, niet de CDN eronder. Zie [Hoe dit gecontroleerd
is](#hoe-dit-gecontroleerd-is) onderaan.

## Bewezen (uit `BatchFormCreator`, draait in productie)

Deze flow maakt formulieren aan en koppelt ze aan assets. Wat hij doet, werkt.

**Regio.** Alle relatie-aanroepen sturen `x-ads-region: EMEA` mee. De
webomgeving draait op `acc.autodesk.eu`. Reken erop dat elke call die regio
nodig heeft.

**Formulier aanmaken.** `POST` met `projectId` + `templateId`, body met
`name`, `description`, `formDate` en optioneel `locationId`.

**Formulier bijwerken.** `PATCH` met `projectId` + `templateId` + `formId`.
De flow patcht hiermee `assigneeId`/`assigneeType` en `notes`. Dat `notes`
patchbaar is via deze route is dus aangetoond — precies wat deze tool nodig
heeft.

**Relatie leggen.** `POST relationship` met `containerId` (= projectId) en een
body met een `entities`-array van twee objecten:

```json
{ "entities": [
  { "domain": "autodesk-bim360-asset",      "type": "asset", "id": "<assetId>" },
  { "domain": "autodesk-construction-form", "type": "form",  "id": "<formId>"  }
]}
```

**Relaties zoeken.** `GET relationships:search` met `containerId`, `domain`,
`type`, `id`, `pageLimit`, `continuationToken`, `includeDeleted`, `onlyDeleted`
en `x-ads-region`. Antwoord:

```json
{
  "page": { "continuationToken": "…", "syncToken": "…" },
  "relationships": [
    { "id": "…", "createdOn": "…", "isReadOnly": false, "isService": false,
      "isDeleted": false,
      "entities": [ { "domain": "…", "type": "…", "id": "…", "createdOn": "…" } ] }
  ]
}
```

Doorbladeren gaat via `continuationToken` tot die leeg is. De volgorde van de
twee entities ligt **niet** vast — de flow filtert expliciet op "welke van de
twee is niet de asset zelf". Dat moeten wij ook doen.

**Voorkomende domeinen:** `autodesk-bim360-asset` (type `asset`),
`autodesk-construction-form` (type `form`), `autodesk-construction-markup`. De
oude flow negeert markups, issues en forms bij het overnemen van referenties.

**Template-id's zijn v5-UUID's.** De voorbeeldwaarden in de flowtrigger
(`d9be8f31-513b-5457-…`, `1b28dcfe-ecd7-599a-…`) hebben versienibble 5. Handige
controle: een v4-GUID is dus géén template-id.

## Waargenomen (uit de selectie-probe, 26-07-2026)

Route: `https://acc.autodesk.eu/build/forms/projects/<projectId>/field-reports/all`

De lijst is een TanStack Table. Rij-objecten in `table.options.data`, met per
rij minimaal:

| Veld | Waarde | Vermoeden |
|---|---|---|
| `uid` | v4-GUID, uniek per rij | formulier-id |
| `type` | v5-GUID, gedeeld door rijen van hetzelfde type | template-id |
| `pg_form.id` | v4-GUID | PlanGrid-formulierdefinitie |
| `pg_form.layoutId` | v4-GUID | PlanGrid-layout |

`projectId` staat zowel in de React-props als in de URL.

## Bewezen tegen de echte API (26-07-2026)

Met de extensie, 3-legged aangemeld, tegen project `948dda3b` op
`acc.autodesk.eu`. Dit is geen documentatie meer maar waarneming.

### Zoeken vanaf de formulierkant werkt

`GET relationships:search` met `domain=autodesk-construction-form&type=form`
levert relaties op — tien in dit project, zonder dat er een formulier-id is
meegegeven. Daarmee is de grootste openstaande aanname van het ontwerp bevestigd:
we hoeven niet vanaf de asset te zoeken en er komt geen omgekeerde index.

`GET utility/relationships:writable` noemt `autodesk-construction-form` met
entiteitstype `form` ook expliciet, naast `autodesk-construction-photo` en de
bekende bim360-domeinen.

`containerId` = de `projectId` uit de ACC-URL, zonder `b.`-voorvoegsel. Bevestigd.

### Het stempel is onzichtbaar op het formulier, maar wél vindbaar

Waargenomen op formulier #2, sjabloon *Lichtmasten plaatseen*:

- Het sjabloon heeft **geen notitieblok aangezet**. Op het formulier zelf is
  nergens te zien dat er iets in `notes` staat.
- In het formulieroverzicht op **Filters → Opmerkingen** zoeken op
  `gekoppelde assets (26-07-2026)` levert het formulier gewoon op.

Twee conclusies, en de eerste is goed nieuws:

1. **Forma Build doorzoekt `notes`.** Daarmee is de openstaande vraag beantwoord:
   we stempelen het juiste veld, niet `description`. Het filter heet in de
   Nederlandse interface *Opmerkingen*.
2. **Of de tekst zichtbaar is, hangt af van het sjabloon.** Staat het
   notitieblok uit, dan schrijft de tool in een veld dat de gebruiker nooit
   onder ogen krijgt. Het filteren werkt, het nalezen niet.

Dat tweede punt is geen storing — het is precies het doel van de tool — maar het
moet wel uitgelegd worden. Zie de meldingseis in `ux-brief.md`.

Nog niet uitgezocht: of via `include=layoutInfo` op `GET forms` v2 te zien is of
een sjabloon het notitieblok aan heeft staan. Kan dat, dan kan het
voorbeeldscherm per formulier melden of de tekst zichtbaar wordt of niet.

### ACC toont categoriepaden met `>`

In het referentiepaneel van een formulier staan de gekoppelde assets als:

```
cc
C > CC
```

Wij schrijven `cc (C > CC)` — hetzelfde scheidingsteken, zodat het stempel leest
als de rest van de interface. Dit bevestigt bovendien dat de opgebouwde paden
kloppen: ACC komt onafhankelijk van ons op dezelfde categorieën uit.

### Een formulier hangt aan méér dan assets alleen

De tien gevonden relaties in dit project:

| Andere kant | Wat het is |
|---|---|
| `autodesk-bim360-asset/asset` | een asset — dit zoeken we |
| `autodesk-bim360-asset/**system**` | géén asset, wel hetzelfde domein |
| `autodesk-construction-schedule/task` | een planningstaak |

**Filter daarom op domein én type.** Kijk je alleen naar het domein, dan glipt
een `system`-id erdoor als was het een asset. Dat valt niet op: onbekende id's
worden door `assets:batch-get` zonder foutmelding weggelaten, dus het formulier
lijkt gewoon een asset te hebben die vervolgens nergens meer opduikt.

De volgorde van de twee entiteiten ligt inderdaad niet vast — in dezelfde tien
relaties staat het formulier soms voorop en soms achteraan. Match dus nooit op
positie.

Eén formulier kan aan meerdere assets hangen (`a66afd32` heeft er drie), en één
asset aan meerdere formulieren (`e6bac120` hangt aan drie). Beide richtingen zijn
dus n-op-n.

### De BIM 360-API moet aan staan op de APS-app

Zolang die uit stond, gaf **elke** aanroep naar de relatieservice een 403 — ook
`utility/relationships:writable`, die helemaal geen container aanraakt. Dat is
het herkenningspunt: gaat álles stuk inclusief `writable`, dan ligt het aan de
app en niet aan rechten, container of regio.

De relatieservice hoort bij de BIM 360-API, de formulieren en assets bij de
ACC-API. Die staan los van elkaar in de app-instellingen. Formulieren ophalen kan
dus prima werken terwijl relaties consequent weigeren.

### `x-ads-region` is verplicht, niet optioneel

Op de EU-tenant, dezelfde aanroep drie keer:

| Regio-header | Uitkomst |
|---|---|
| `EMEA` | **200** |
| *weggelaten* | 403 — `AUTH-001`, "the client_id specified does not have access" |
| `US` | 403 — "no permission to execute this action on the container" |

De documentatie zegt dat de aanvraag zonder header "automatisch gerouteerd"
wordt. Op een container in EMEA klopt dat niet: dan krijg je een foutmelding die
naar de app-registratie wijst en je op het verkeerde spoor zet.

`utility/relationships:writable` werkt wél met elke regio, omdat daar geen
container aan te pas komt. Handig als controlepunt, misleidend als maatstaf.

Kortom: stuur `x-ads-region` op elke container-aanroep. `FormaClient` doet dat.

## Gecontroleerd tegen de documentatie (26-07-2026)

### De richting van de relatiezoekopdracht is geen probleem

De relatieservice is expliciet bi-directioneel: *"relationships are
bi-directional, there is no notion that a relationship can only be followed in a
single direction."* De zoekparameters zijn symmetrisch — `domain`/`type`/`id`
aan de ene kant, `withDomain`/`withType`/`withId` aan de andere.

Dat de oude flow vanaf de asset zoekt, is dus een keuze en geen beperking.
Samen met het bewezen domeinpaar hierboven wordt onze zoekopdracht:

```
domain=autodesk-construction-form&type=form&id=<formId>
&withDomain=autodesk-bim360-asset&withType=asset
```

**De omgekeerde index als terugvaloptie vervalt daarmee.**

### `relationships:intersect` past beter dan `:search`

Naast `:search` bestaat `POST containers/:containerId/relationships:intersect`.
Dat neemt een **set** entiteiten in één aanroep, gefilterd op `withEntities`. De
documentatie beschrijft precies onze situatie: een bekende set entiteiten, en de
vraag waar die aan hangen.

Wij sturen de geselecteerde formulieren als `entities` en beperken `withEntities`
tot `autodesk-bim360-asset`. Scheelt een aanroep per formulier.

Let op: **`entities` heeft `Min items: 1, Max items: 20`.** De selectie moet dus
in blokken van 20 door. Beide endpoints zijn `data:read` en 3-legged.

### Formulieren bijwerken

```
PATCH https://developer.api.autodesk.com/construction/forms/v1
      /projects/:projectId/form-templates/:templateId/forms/:formId
```

Scope `data:write`, user context vereist — 3-legged Authorization Code of een
Secure Service Account. Sluit aan bij de gekozen PKCE-opzet.

Twee dingen die het ontwerp raken:

- **De `projectId` verschilt van die van Data Management.** Het `b.`-voorvoegsel
  moet eraf: `b.a4be0c34a-4ab7` wordt `a4be0c34a-4ab7`.
- **PDF-formulieren worden niet ondersteund.** Uit de selectie filteren, met een
  melding in het voorbeeldscherm.

### De 8000 tekens kloppen

`Max length: 8000` staat op **`notes`** — precies zoals `workflow.md` aannam. Op
`description` staat dezelfde grens, en op `name` staat 100.

Het stempel gaat in **`notes`**, niet in `description`. De afbouwladder bij 8000
tekens blijft dus ongewijzigd gelden.

### Status en het heropenen van gesloten formulieren

Bewerken mag alleen in `draft` of `inReview`. De referentie is stellig over de
rest: *"submitted forms are closed and no longer editable"*, en archived
formulieren zijn niet bewerkbaar en verborgen in de UI.

Toegestane waarden bij het patchen (v1): `draft`, `discarded`, `submitted`,
`archived`, `in_review`. De responsstructuur van diezelfde v1-aanroep noemt de
status `inReview` in plaats van `in_review` — daar moet je bij het bouwen op
letten. Zie ook de statustabel hieronder: v2 gebruikt weer andere waarden.

**Openstaand risico.** Het ontwerp gaat ervan uit dat een gesloten formulier
heropend kan worden met een status-`PATCH`. Geldt "no longer editable" ook voor
het statusveld zelf, dan werkt die route niet en is heropenen via de API
onmogelijk. Dat is niet uit de documentatie op te maken. Probeer het op één
testformulier vóór de optie "gesloten formulieren meenemen" gebouwd wordt — zo
niet, dan vervalt die optie, en daarmee ook de zorg over het overschrijven van
"gesloten door".

### Forms v2 — maar niet voor alles

**Besluit: we bouwen op v2** (release april 2026). `GET forms` v1 heet in de
referentie al "Deprecated".

Let op dat v2 **geen volledige versie van de Forms-API is**. De migratiegids
behandelt precies twee endpoints: `GET forms` en `PUT values:batch-update`. Voor
de rest bestaat er geen v2-variant.

| Aanroep | Versie |
|---|---|
| Formulieren ophalen | **v2** — `GET /construction/forms/v2/projects/{projectId}/forms` |
| Notities patchen | **v1** — er is geen v2 voor `PATCH forms/:formId` |

Deze tool gebruikt dus beide versies naast elkaar. Dat is geen tijdelijke
situatie om weg te werken, maar de huidige stand van de API.

Wat v2 verder verandert voor onze leesaanroep:

- `data.formTemplate` is vervangen door `data.formTemplateId` — dat is precies
  de template-id die we voor de `PATCH`-URL nodig hebben, dus die halen we daar
  vandaan.
- Nieuw: `search`, `sort` (multi-field), `include`, `includeSubLocations`.
  `sortBy`/`sortOrder` en `includeInactiveFormTemplates` vervallen.
- Weerdata zit er niet meer in, alleen `weatherId`. Niet relevant voor ons.

#### De statuswaarden verschillen per versie — dit is een valkuil

v2 hernoemde de statussen naar de UI-labels, maar de v1-`PATCH` kent alleen de
oude waarden. Bij het lezen krijg je dus andere strings terug dan je bij het
schrijven mag versturen:

| v1 (`PATCH`) | v2 (`GET`) | UI |
|---|---|---|
| `draft` | `inProgress` | In Progress |
| `in_review` | `inReview` | In Review |
| `submitted` | `closed` | Closed |
| `discarded` | `discarded` | Discarded |
| `archived` | `archived` | Archived |

De `status`-queryparameter op `GET forms` v2 gebruikt óók de v2-waarden — filter
op `status=inProgress`, niet op `status=draft`.

Bouw deze vertaling op één plek, en sla in het journaal de **v1-waarde** op:
dat is wat een terugdraaiactie moet kunnen terugschrijven.

### Assets en categorieën

| | |
|---|---|
| `GET /construction/assets/v2/projects/:projectId/assets` | `data:read`. Levert o.a. `clientAssetId`, `categoryId`, `description`. Paging via `cursorState`. |
| `GET /construction/assets/v1/projects/:projectId/categories` | `data:read`. Levert `id`, `name`, `parentId`. |

Let op dat assets op **v2** zitten en categorieën op **v1**.

**Een asset heeft geen `name`-veld.** De naam die de gebruiker kent, staat in
`clientAssetId`: *"This value appears as 'Asset ID' in the Assets UI, and may
sometimes be called 'Name' in asset exports."* Er is daarnaast een
`description` (max 1000 tekens), maar dat is niet de naam. In het stempel
gebruiken we `clientAssetId`.

Er is geen kant-en-klaar padveld: het categoriepad bouw je door `parentId` omhoog
te volgen tot de wortel. Eenmalig de hele boom ophalen en omzetten naar
`categoryId → pad` is dus de juiste aanpak, zoals `workflow.md` al voorstelt.
`filter[parentId]` en `filter[maxDepth]` bestaan als je maar een deelboom nodig
hebt.

### Scopes

`data:read` voor relaties, assets en categorieën; `data:write` voor de
formulier-`PATCH`. Alles in user context (3-legged). Dat bevestigt het vermoeden
uit de ontwerpfase.

## Nog te bevestigen

- **`uid` is de formulier-id die de publieke API verwacht.** Er zijn meerdere
  id-achtige velden per rij; `pg_*` wijst op PlanGrid-interne sleutels. Open één
  formulier in ACC en vergelijk de GUID in de adresbalk met `uid`.
- **Of een gesloten formulier via de API heropend kan worden.** Zie hierboven;
  dit bepaalt of een van de ontwerpkeuzes overeind blijft.
- **Of `GET forms` v2 stabiel genoeg is.** In de referentie staat die nog als
  "New - Beta" terwijl v1 al "Deprecated" heet. We bouwen op v2; houd er
  rekening mee dat het contract nog kan schuiven.
- ~~Of `autodesk-construction-form` in de zoekrichting werkt.~~ **Bewezen** —
  zie hierboven.
- ~~Of Forma Build op `notes` of op `description` zoekt.~~ **`notes`** — het
  filter *Opmerkingen* vindt een gestempeld formulier terug. Zie hierboven.

Terzijde, uit de formulier-URL af te lezen:

```
/field-reports/<templateId>/reports/<formId>
```

Handig voor het testen: zo heb je beide id's die de `PATCH` nodig heeft zonder
een lijstaanroep te doen.

## Hoe dit gecontroleerd is

Twee skills in `.claude/skills/`, allebei bruikbaar zonder verdere opzet:

- **`aps-docs`** — navigeert de APS-documentatie via de JSON-inhoudsopgave per
  API (`acc_v1.json` voor alles hierboven) en haalt referentiepagina's als tekst
  op. Dit is de route die alle bovenstaande antwoorden heeft opgeleverd.
- **`aps-sdk-openapi`** — leest de OpenAPI-specificaties waaruit Autodesk zijn
  SDK's genereert. Nauwkeuriger dan de HTML-documentatie, maar **ACC Forms,
  Assets en de relatieservice zitten er niet in**. Voor dit project dus vooral
  bruikbaar voor de authenticatiekant.

De skills gaan uit van `htmlq`, `jq` en `yq`; die staan hier geen van drieën
geïnstalleerd. Python is er wel en volstaat voor het uitlezen van de JSON-TOC en
het omzetten van HTML naar tekst.

### Bronnen

- [PATCH forms/:formId](https://aps.autodesk.com/en/docs/acc/v1/reference/http/forms/forms-formId-PATCH/)
- [Forms API Migration Guide v1 → v2](https://aps.autodesk.com/en/docs/acc/v1/overview/migration-guides/Forms_v1_to_v2/)
- [GET relationships:search](https://aps.autodesk.com/en/docs/bim360/v1/reference/http/relationship-service-v2/search-relationships-GET/)
- [POST relationships:intersect](https://aps.autodesk.com/en/docs/bim360/v1/reference/http/relationship-service-v2/intersect-relationships-POST/)
- [Relationship Querying](https://aps.autodesk.com/en/docs/bim360/v1/tutorials/relationships-tutorial/)
- [GET assets V2](https://aps.autodesk.com/en/docs/acc/v1/reference/http/assets/assets-v2-GET/)
- [GET categories](https://aps.autodesk.com/en/docs/acc/v1/reference/http/assets/categories-GET/)
