# API-aantekeningen

Verzamelde kennis over de APS/ACC-kant. **Let op de herkomst per regel**: een
deel is afgeleid uit een draaiende Power Automate-flow en dus bewezen, een deel
is nog aanname. De Autodesk-documentatie was tijdens het opstellen niet
bereikbaar vanuit de ontwikkelomgeving (403 via de netwerkproxy), dus niets
hieronder is tegen de officiële referentie gecontroleerd.

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

## Nog te bevestigen

- **`uid` is de formulier-id die de publieke API verwacht.** Er zijn meerdere
  id-achtige velden per rij; `pg_*` wijst op PlanGrid-interne sleutels. Open één
  formulier in ACC en vergelijk de GUID in de adresbalk met `uid`.
- **Richting van de relatiezoekopdracht.** De oude flow zoekt alleen vanaf de
  asset. Wij hebben formulier → assets nodig. Werkt `domain=autodesk-construction-form`,
  `type=form` niet, dan bouwen we eenmalig een index over alle assets van het
  project en draaien we die om.
- **Statuswaarden en welke patchbaar zijn.** Bekend is dat gesloten
  formulieren niet bewerkbaar zijn maar wel heropend kunnen worden. De exacte
  waarden en de endpoints voor statusovergangen zijn niet gecontroleerd.
- **Assets en categorieën.** De endpoints voor assetdetails en de
  categorieboom zijn niet gecontroleerd. Nodig: assetnaam, categorie-id, en per
  categorie de ouder, om het volledige pad (`1->Ba->24`) te kunnen opbouwen.
- **Scopes.** Vermoedelijk `data:read` + `data:write`, plus iets voor
  hub-/projectlijsten. Niet gecontroleerd.
- **De grens van 8000 tekens op `notes`.** Opgegeven, niet geverifieerd.

## Voor je verder bouwt

Zet `*.autodesk.com` en `*.autodesk.eu` open in de ontwikkelomgeving, of houd de
documentatie er los naast. Zonder referentie wordt de API-laag gokwerk op
parameternamen — en dat is precies het soort fout dat pas bij de eerste echte
schrijfactie aan het licht komt.
