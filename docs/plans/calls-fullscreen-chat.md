# Calls — chat while in fullscreen

Status: **Option A built.** Ratified by Kris 2026-07-26; implemented in this branch.

## The complaint

Opening call chat from fullscreen throws you out of fullscreen.
`ChatButton` (`apps/frontend/src/components/call/call-control-buttons.tsx:117`)
navigates to `?panel=draft:<streamId>:<chatAnchorId>` and, on the way, forces the
surface down: `setDesktopSurfaceOverride("sidebar")` on desktop,
`setCallSurfaceMode("standard")` on mobile.

That eject is deliberate, not sloppy. The fullscreen surface is an opaque overlay
(`desktop-call-fullscreen.tsx:87`, `fixed inset-y-0 right-0 z-40`, left edge at
`--app-content-left`) mounted _outside_ `PanelProvider`
(`workspace-layout.tsx:481-528`: `<CallDock />` sits after the provider closes).
Without the eject the thread panel opens underneath the overlay, invisible.

## Is a pane revamp the answer?

Partly — the diagnosis is right, the revamp is not needed to fix this.

**Every non-fullscreen case already is the split.** With the side dock, the
desktop layout is nav | timeline | thread panel | call dock: `<main>` reserves
room via `--call-dock-inset-right` (`app-shell.tsx:463`,
`desktop-call-dock.tsx:377`) and the route's own resizable split renders the
panel (`stream.tsx` + `usePanelLayout`). Call chat there is the ordinary thread
panel and it works today. Nothing bespoke is warranted; nothing needs building.

**Fullscreen is the single case that opted out of the layout system.** It is an
overlay because it must survive navigation and carry no URL state. So the fix is
to make the overlay respect the panel instead of covering it.

The full pane revamp — one owner laying out `{main, panel, call}` so the call
becomes a pane rather than an overlay — is a genuinely bigger idea (it also gives
side-by-side threads, call-as-pane on any route, persisted pane geometry). It
should not ride on this fix. Recorded as its own item, not planned here.

## Option A — reserve the panel column (recommended)

Publish the panel's live width as a CSS var and have the fullscreen overlay stop
short of it.

- `ThreadPanelSlot` — the single component that owns the desktop panel column, and
  the one the mobile take-over path never mounts — writes `--panel-inset-right` =
  its display width, and `--panel-inset-duration` = `200ms` while it animates,
  `0ms` while the user drags the resize handle. Mirrors what `desktop-call-dock`
  does with `--call-dock-inset-right`, unmount reset included.
- `DesktopCallFullscreen` renders with `right: var(--panel-inset-right, 0px)` and
  transitions that edge over `--panel-inset-duration` using Tailwind's `ease-out`
  curve — the CSS `ease-out` keyword is a different curve and the two edges drift
  ~70px apart mid-transition, flashing the timeline between them.
- `ChatButton` drops the desktop eject. Fullscreen stays fullscreen; the thread
  panel appears in the reserved column.

Why it works cleanly: in fullscreen the side dock unmounts and its cleanup resets
`--call-dock-inset-right` to `0`, so `<main>` is full-width beneath and its panel
sits flush against the viewport's right edge — the gap the overlay leaves lands
exactly on it. One mount of the panel, no duplicate subscriptions or draft state,
and the chat is the same `StreamPanel` as everywhere else.

Cost: one CSS var pair, one style line, one deletion. Browser-verified at 1280px:
overlay `x=260 w=540` ends exactly where the panel starts (`x=800 w=480`).

`ThreadPanelSlot` has a third mount besides `stream.tsx` and `board.tsx` — the
persona editor's test-chat pane (`pages/persona-editor.tsx`). It publishes the
same inset, so a fullscreen call over that route would reserve a column for the
test pane. Harmless and vanishingly rare; left alone deliberately.

Mobile is unchanged: the panel replaces the main column there, so fullscreen
collapsing to `standard` stays correct.

## Option B — chat pane inside the overlay

Move `<CallDock />` inside `PanelProvider` and let the fullscreen surface render
`<PanelHost>` itself in a right column.

Rejected: the route underneath still mounts its own panel for the same
`?panel=` value, so the thread mounts twice — duplicate fetches, duplicate
composer/draft state. Avoiding that means one owner deciding who renders the
panel, which is the pane revamp, not this fix.

## Option C — do nothing but make the eject honest

Keep the surface switch, but announce it and restore fullscreen when the chat
panel closes. Cheapest, still surprising. Only worth it if Option A's edge
alignment turns out worse in practice than it reads.

## Decision needed

Confirm Option A. Then it is a single small PR: `--panel-inset-right` +
fullscreen `right` + drop the desktop eject, with tests covering
fullscreen-with-panel geometry and that the desktop surface no longer changes
when chat opens.
