
# Handoff: Forma Form Stamper (browser extension popup)

## Overview
A browser-extension popup for Heijmans project teams working in Forma Build (Autodesk). It lets a user select forms in the Forma Build page, then "stamps" them: writes the linked asset references into each form's notes field. The popup runs alongside the Forma Build page and walks the user through 4 steps.

## About the Design Files
The files in `screens/` are **design references built in HTML/CSS** — static mockups of each screen's default look, not production code. Recreate them in the target codebase's actual extension framework (e.g. a Chrome/Edge Manifest V3 popup with your existing component library) rather than shipping this HTML as-is.

## Fidelity
**High-fidelity.** Colors, type, spacing, and copy are final (Heijmans huisstijl: Heijmans Bold Condensed for headings, Heijmans Light/Normal for body, brand blue #003366, yellow #feb900). Recreate pixel-for-pixel where the target stack allows.

## Screens
Open each file in `screens/` directly in a browser.

1. **01-inloggen.html** — Inloggen (Step 1/4). Not-logged-in state; only a title, one line of copy, and a single primary button.
2. **02-selecteren.html** — Selecteren (Step 2/4). Shows the project name, a live count of selected forms, an "ook gesloten formulieren" toggle, and a table (Formulier / Gekoppelde assets / Status) with sticky header.
3. **03-stempelen.html** — Stempelen (Step 3/4), happy path, all forms done.
   **03b-stempelen-fout.html** — same step, one form failed.
4. **04-samenvatting.html** — Samenvatting (Step 4/4). Journal of past stamp runs, each with an undo action.

Popup width is fixed at 420px (matches a real browser-extension popup). The header (icon + step label) and the panel's intro lines never scroll — only the list content below them does, inside a capped-height scroll area.

## UX Flow
See **UX-FLOW.md** for the full navigation map, state transitions, and error handling.

## Design Tokens
- Brand blue: `#003366` · Yellow (status bar): `#feb900` · Red (errors): `#ed0500`
- Neutral borders: `#e6e6e5` · Pale blue tint: `#e7edf9` · Success green (done dot): `#4a9b6e`
- Display font (headings/step counters): "Heijmans Bold Condensed"
- Body/UI font: "Heijmans Normal" / "Heijmans Light"
- Popup corner radius: 0 (square, matches Heijmans shape language) · Pills (status tags, buttons, toggle track): fully rounded (999px)

## Assets
- `fonts/` — Heijmans OTF font files used via `@font-face`, bundled alongside each screen file.
- All icons are inline SVG (no external icon files).

## Files
- `screens/*.html` — one file per screen, self-contained (fonts referenced via relative `./fonts/`).
- `UX-FLOW.md` — flow, transitions, and error/edge-case behavior.
