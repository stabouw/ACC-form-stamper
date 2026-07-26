---
name: aps-sdk-openapi
description: Answer questions about exact APS (Autodesk Platform Services) REST API contracts — request/response schemas, parameter names and types, required fields, auth scopes, and sample payloads — by querying the official OpenAPI specs in github.com/autodesk-platform-services/aps-sdk-openapi. Use when the user needs ground-truth, code-level detail (e.g. "what fields does the Item schema have", "what's the exact query param for X", "what scopes does endpoint Y need") rather than narrative/conceptual documentation.
---

This skill answers APS questions from the **OpenAPI specs that generate the official APS SDKs** —
`https://github.com/autodesk-platform-services/aps-sdk-openapi` (branch `main`). These are the
ground-truth, machine-readable contracts: every path, parameter, request/response schema, security
scope, and often a realistic `x-examples` payload. Prefer this skill over `aps-docs` whenever the
user needs an exact field name, type, required-ness, or a sample JSON body — narrative HTML docs
can drift from the real contract; the OpenAPI spec cannot.

## When to use this vs. `aps-docs`

- **Use `aps-sdk-openapi`** for: exact endpoint signatures, request/response JSON shape, enum values,
  required vs optional fields, security/scope requirements, realistic example payloads.
- **Use `aps-docs`** for: conceptual guides, tutorials, migration notes, webhook event catalogs in
  prose, and any API **not covered by this repo** — see coverage gaps below.
- They're complementary: look up the *contract* here, look up the *how/why* there.

## Repo coverage (as of last check — re-list the tree if this may be stale)

| File (path in repo) | API | Title | # paths |
|---|---|---|---|
| `authentication/authentication.yaml` | Auth | Authentication | 8 |
| `construction/accountadmin/accountadmin.yaml` | ACC | Construction.Account.Admin | 21 |
| `construction/issues/Issues.yaml` | ACC | Construction.Issues | 11 |
| `datamanagement/datamanagement.yaml` | DM | Data Management (hubs/projects/folders/items/versions) | 35 |
| `modelderivative/modelderivative.yaml` | MD | Model Derivative | 11 |
| `oss/oss.yaml` | OSS | Object Storage Service | 15 |
| `secureserviceaccount/secureServiceAccount.yaml` | SSA | Secure Service Account | 5 |
| `webhooks/webhooks.yaml` | Webhooks | Webhooks | 7 |

**Not in this repo** (fall back to `aps-docs` or the portal): AEC Data Model, Viewer, Design
Automation, Tandem, most other ACC modules (Cost, RFIs, Submittals, Sheets, Forms, Photos, etc.),
BuildingConnected, Forma, Parameters, Manufacturing Data Model. If asked about one of these,
say so rather than guessing.

All specs are OpenAPI 3.0.1, server `https://developer.api.autodesk.com`.

---

# Method

## Step 1 — Get the file tree (only if the table above might be stale)

```bash
curl -sS "https://api.github.com/repos/autodesk-platform-services/aps-sdk-openapi/git/trees/main?recursive=1" \
  | jq -r '.tree[] | select(.type=="blob") | .path'
```

`api.github.com` and `raw.githubusercontent.com` are plain public GitHub endpoints — no auth needed
for this public repo. If these are blocked by network policy in your sandbox, report that rather
than retrying (see the environment's proxy README for guidance) — do not attempt `git clone`, since
git operations may be rewritten through a repo-scoped proxy that only allows the current project's
own repo.

## Step 2 — Identify the right spec file

Match the question's keywords/API name to a row in the coverage table. If ambiguous (e.g. "file
changes" could be Data Management *or* ACC), check both.

## Step 3 — Download the spec to a scratch/temp directory

```bash
mkdir -p /tmp/aps-sdk-openapi-cache
curl -sS "https://raw.githubusercontent.com/autodesk-platform-services/aps-sdk-openapi/main/{path}" \
  -o /tmp/aps-sdk-openapi-cache/{basename}.yaml
```

Cache per-session; re-fetch if the conversation spans a long time or accuracy is critical, since
`main` can move. Never dump a full file into context — these run 30KB–350KB. Always query with
`yq`/`jq` (below) and only view the slice you need.

## Step 4 — List candidate endpoints (method, path, operationId, summary)

```bash
yq -r '.paths | to_entries[] | .key as $p | .value | to_entries[]
  | select(.key as $m | ["get","post","put","patch","delete"] | index($m))
  | "\(.key|ascii_upcase)\t\($p)\t\(.value.operationId)\t\(.value.summary)"' file.yaml
```

Filter by keyword (path, summary, or tag):

```bash
yq -r '.paths | to_entries[] | .key as $p | .value | to_entries[]
  | select(.key as $m | ["get","post","put","patch","delete"] | index($m))
  | select(($p + " " + (.value.summary // "")) | test("search|folder"; "i"))
  | "\(.key|ascii_upcase)\t\($p)\t\(.value.operationId)\t\(.value.summary)"' file.yaml
```

## Step 5 — Pull the full operation detail

```bash
yq -r '.paths."/data/v1/projects/{project_id}/folders/{folder_id}/search".get' file.yaml
```

This gives `parameters` (often `$ref`s), `requestBody`, `responses`, and `security` (the exact
OAuth scopes required — e.g. `data:read`, `data:write`, `data:create`, `2-legged` vs `3-legged`).

## Step 6 — Resolve `$ref` pointers

Refs are local (`#/components/...`) — resolve with a second targeted query, not a full dump:

```bash
# a shared parameter
yq -r '.components.parameters.filter' file.yaml

# a response/request schema
yq -r '.components.schemas.Search' file.yaml
```

Chain as needed for nested refs (schema → property → `$ref` → another schema).

## Step 7 — Check for `x-examples`

Many `components.schemas.*` entries carry an `x-examples` block with a **realistic sample
payload** (real-shaped IDs, URNs, attribute names). This is more reliable than hand-writing an
example — always check for it before improvising a sample request/response body:

```bash
yq -r '.components.schemas.Search.x-examples' file.yaml
```

## Step 8 — Compile the answer

State: HTTP method + path, required path/query params (with types), auth scopes needed
(2-legged/3-legged/SSA), request body shape if applicable, response shape, and a realistic
example (from `x-examples` if available, otherwise a minimal curl). Link the human-readable page
too if useful: `https://github.com/autodesk-platform-services/aps-sdk-openapi/blob/main/{path}`.

---

# Worked example: "exact params for finding a file by name in an ACC folder"

1. **File**: `datamanagement/datamanagement.yaml` (folders/items live in Data Management).
2. **List candidates** filtered on "folder|search" → finds `GET
   /data/v1/projects/{project_id}/folders/{folder_id}/search` (`operationId: getFolderSearch`,
   summary "List Folder and Subfolder Contents") — searches a folder **recursively**, unlike
   `.../folders/{folder_id}/contents` which only lists direct children.
3. **Parameters**: `$ref` → `components.parameters.filter`, a generic `filter[*]` query-string
   family (array of strings) — the spec doesn't enumerate exact filterable field names here (that
   detail lives in the narrative Filtering guide, so cross-check with `aps-docs` if you need the
   precise `filter[attributes.displayName]`-style key), plus `page_number` for pagination.
4. **Security**: `3-legged` only, scopes `data:read` + `data:search` — a 2-legged token is *not*
   accepted for this operation (confirmed straight from the spec, not assumed).
5. **Response**: `$ref` → `components.schemas.Search` → `data[]` items are `$ref
   components.schemas.VersionData` (the version resource, with `attributes.displayName` /
   `attributes.name` holding the file name) and `included[]` are the parent `ItemData` resources.
   The schema's `x-examples` shows a full realistic payload (`sample.txt`, `sample.pdf`) confirming
   this shape.

This is strictly more precise than what's derivable from narrative docs alone — the spec pinned
down the recursive-search endpoint, the 3-legged-only auth requirement, and the exact response
schema/field names directly from source.

---

## Gotchas

- Don't `git clone` this repo — use the GitHub REST/raw endpoints (Steps 1/3); `git` may be routed
  through a proxy scoped to a different repository in some sandboxes.
- Files are large; always filter with `yq`/`jq`, never cat/paste the whole spec into context.
- `$ref`s are one level at a time — there's no automatic deep-resolution tool here, chain queries.
- This repo excludes several APS APIs (see coverage table) — don't infer their contracts by
  analogy; say they're out of scope and point to `aps-docs` or the portal instead.
- Pin to a commit SHA (`.../raw/{sha}/...`) instead of `main` if you need reproducibility across a
  long-running task, since the spec files do get updated.
