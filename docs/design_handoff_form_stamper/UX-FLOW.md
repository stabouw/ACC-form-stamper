
# UX Flow — Forma Form Stamper

4 linear steps, shown as a step counter ("Stap X van 4") in the popup header. No step can be skipped except by using the browser back-equivalent ("Terug") button.

```
Inloggen  →  Selecteren  →  Stempelen  →  Samenvatting
 (1/4)         (2/4)          (3/4)          (4/4)
```

## 1. Inloggen (login)
- **Entry condition:** popup opens and there is no valid Autodesk token (first use, expired/revoked token, or user logged out).
- **Content:** title + one line explaining why login is needed + one primary button ("Inloggen bij Autodesk →").
- **Action:** click triggers the Autodesk OAuth flow in a system/browser window. On success, the popup receives the token and advances straight to **Selecteren** (no separate "logged in" screen — login is a means to an end, not a destination).
- **If login fails or is cancelled:** stay on this screen; no separate error screen is defined yet (flag this as an open item for engineering — recommend a one-line inline error above the button, e.g. "Inloggen mislukt — probeer opnieuw", plus a Design Team follow up if a token-expired/re-auth variant is needed).
- **Uitloggen:** a logout action is available once logged in (surfaced on Selecteren or via the extension menu) and returns the user here.

## 2. Selecteren (select forms)
- **Entry condition:** valid token. Selection itself does not happen inside the popup — the user checks boxes on the actual Forma Build page; the popup passively reflects that selection live.
- **Content:** project name, live "X formulieren geselecteerd" count, a toggle for including closed forms, and a table (Formulier / Gekoppelde assets / Status) listing every selected form with its linked assets and whether stamping it would be new/updated/unchanged/near the character limit.
- **Table behavior:** header row is sticky; body scrolls independently once content exceeds the popup's fixed height. Header, project name, and count never move.
- **Empty state (0 selected):** count line turns red ("0 formulieren geselecteerd"), table shows headers only, and the primary button ("Stempelen →") is disabled (shown in light blue, not click-disabled via opacity) until at least one form is checked.
- **Action:** "Stempelen →" advances to **Stempelen**. "Terug" returns to Inloggen (functions as logout/reset entry point, not a literal previous-step nav since selection lives outside the popup).

## 3. Stempelen (stamping in progress → done)
- **Entry condition:** ≥1 form selected.
- **Behavior:** forms are processed one at a time, top to bottom, in selection order. Each row shows a filled green check when done, a dashed pending ring for "not yet started," and a muted "Bezig…" label for the one currently in progress.
- **Scroll behavior:** heading and the summary line ("X van Y formulieren verwerkt") are pinned; only the row list scrolls, capped to ~4 visible rows. As each form completes, the list auto-scrolls down so the active/newest row is always visible — older completed rows remain reachable by scrolling up.
- **On completion:** summary line switches to a static count ("4 formulieren · 0 gesloten formulieren heropend"), the button ("Naar samenvatting →") remains enabled, "Annuleren" changes to no-op since the run is done.
- **If one or more forms error** (`03b-stempelen-fout.html`): the row shows a red X dot and an inline red error line (e.g. "Fout: formulier is gesloten — niet in selectie voor heropenen"). The primary path still continues to Samenvatting; a secondary "1 fout opnieuw proberen" button lets the user retry just the failed form(s) without re-running the whole batch. The list's scroll position stays pinned to the bottom (the end of the run) on load, since this screen represents a finished state.
- **Annuleren:** available while a run is in progress; stops processing remaining forms (already-completed ones keep their stamp) and returns to Selecteren.

## 4. Samenvatting (summary / undo)
- **Entry condition:** a stamp run has completed (with or without errors).
- **Content:** a journal of past runs (most recent first), each with a timestamp, relative time ("zojuist", "4 mnd geleden"), a one-line result summary, and an "Ongedaan maken" (undo) button that reverts that run's note changes.
- **Scroll behavior:** same fixed-header pattern as steps 2/3 — heading and intro line are pinned, the journal list scrolls in a capped-height area beneath them.
- **Undo:** reverts the notes written by that specific run back to their prior content (each run stores the pre-stamp state). Undo does not require re-authentication or re-selection.
- **Nieuwe uitvoering starten:** returns to Selecteren to start another pass over the current (or updated) selection. **Sluiten** closes the popup entirely; state (auth, journal) persists for next open.

## Error handling summary
| Situation | Where it surfaces | Recovery |
|---|---|---|
| No/expired token | Inloggen shown on open | User logs in again |
| Login fails/cancelled | Stays on Inloggen | Retry button (needs explicit copy — open item) |
| 0 forms selected | Selecteren, red count + disabled button | User checks a box on the Forma Build page |
| Form near/at character limit | Selecteren table, "limiet" tag + inline warning | User trims the asset list or notes before stamping |
| Form closed / can't be stamped | Stempelen, red X + inline error | "1 fout opnieuw proberen" retries just that form |
| User cancels mid-run | Stempelen, "Annuleren" | Already-stamped forms keep their result; back to Selecteren |
| User wants to revert a past run | Samenvatting | "Ongedaan maken" on that run's row |
