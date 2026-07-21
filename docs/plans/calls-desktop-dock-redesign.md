# Calls — Desktop dock redesign

Status: **draft, awaiting ratification**. Approved visual direction: the [desktop dock mock](https://seer.build/ws_vbyzjvdg6g/b/calls-deskdock-1ca712/).

Desktop-only. Mobile surfaces (`mobile-call-drawer.tsx`, `call-island.tsx`) are unchanged. Reference files: `apps/frontend/src/components/call/desktop-call-dock.tsx` (628 lines — top/side dock, `nearestStep` snaps, `--call-dock-inset-*` content push, `ResizeObserver` ceiling), `call-dock.tsx` (phase router), `stores/call-prefs-store.ts`.

## Goals (from Kris's desktop feedback)

1. **Kill the top dock** — it felt awkward; drop the top orientation entirely. Desktop is **side** or **floating** only.
2. **Floating square = effective default** — a small draggable, minimizable call widget (grip to move anywhere, minimize to a bubble), with a **"dock to side"** action. Joining renders **in the same square** (no bottom-right→dock jump).
3. **Side dock behaves like the nav sidebar** — **hover-to-overlay** when minimized (opens over the content, doesn't push, like the nav sidebar's closed-hover), plus an open/pinned draggable mode; **freeform width** (remove the width snap detents — snaps control layout/things, not width); **75% max**; a **drop-to-fullscreen indication** past 75% on release; a **"float"** action to switch to the square.
4. **Collapsed side rail** — put controls (mute / camera / leave) in the wasted vertical space above the timer.
5. **Surface pref** `desktopCallSurface: keep_last | sidebar | floating` (default `keep_last`). `keep_last` remembers the last-used surface; the floating square is the effective default. A control in **Calls settings**.

## Invariants in play

- INV-9 (call-prefs singleton exception), INV-33 (settings-tab config SSOT), INV-15/18 (components UI-only, no inner defs), INV-21 (no layout shift from the hover-overlay/drag), INV-40 (actions = `<button>`), INV-63 (success silent). The content push uses the existing `--call-dock-inset-*` mechanism. Keep the smooth pointer-drag feel (the current dock's pointer loop is the reference — Kris likes it).

## PR-stack breakdown

Each chunk is one PR, based on the previous branch (chunk 1 on `origin/main`).

### Chunk 1 — Remove the top dock (side-only)

- `desktop-call-dock.tsx`: delete the top orientation — `PanelTop`/`PanelBottom` icons, the Top/Side toggle in the dock header, `TOP_STEP_SIZES`/`detentsH`, and the `mode`-vs-`dockPosition` branches for top. Desktop dock renders side-only.
- `call-prefs-store.ts`: `dockPosition` loses `"top"` — either narrow to `"side"` (vestigial, removed in Chunk 4) or drop the field now if no other reader needs it; `filmstripSide` stays.
- `layout-toggle.tsx` / dock header: remove the Top/Side control (the Speaker/Grid + filmstrip-side toggles stay).
- Tests: drop the top-mode cases in `desktop-call-dock.test.tsx`; keep side-mode coverage green.
- **NOT**: no new surface yet; no pref changes beyond removing `top`.

### Chunk 2 — Side dock: freeform width + 75% cap + drop-to-fullscreen cue + hover-overlay + collapsed controls

- **Freeform width**: replace the width `nearestStep` detents with a continuous clamp `[MIN, 0.75 * ceilW]`; drop the width snap. Keep the smooth pointer drag; commit width to a persisted pref (`sideDockWidth`) on release. (Layout snaps — Speaker/Grid, filmstrip side — are unaffected: those are _content_ toggles, not width.)
- **75% cap + drop-to-fullscreen**: dragging past the 75% ceiling shows a **drop-to-fullscreen overlay** (dashed, "Release to go fullscreen"); releasing in that zone → fullscreen, releasing below → clamp to ≤75%. A deliberate zone so fullscreen is intentional.
- **Hover-to-overlay when minimized**: the minimized rail, on hover, expands the dock **over** the content (position: absolute, no `--call-dock-inset` push) — mirroring the nav sidebar's closed-hover (`app-shell.tsx` preview state). Pinned/open still pushes.
- **Collapsed rail controls**: `SideRailView` gains mute / camera / leave (shared `call-control-buttons`) above the timer.
- Tests: freeform clamp (no snap; ≤75%), fullscreen-zone release vs clamp release, hover-overlay adds no inset, rail controls dispatch.
- **NOT**: the floating square; the surface pref.

### Chunk 3 — Floating square surface (component only)

- New `floating-call-square.tsx`: a draggable (grip / whole-header drag via pointer capture, clamped to viewport), **minimizable** (collapse to a small bubble showing dot + timer; click to restore) call widget rendering tiles + the shared controls; a **"dock to side"** action.
- Joining renders in the same square (a compact "Joining…" state — unify like the mobile `MobileCallJoining`, no separate bottom-right box).
- Not yet the default — rendered behind the pref in Chunk 4; this chunk lands the component + its tests in isolation (render at a fixed position, drag math via a pure helper, minimize toggle).
- Tests: drag clamp helper (pure), minimize/restore, controls dispatch, joining state.
- **NOT**: wiring the pref / switching / keep_last.

### Chunk 4 — `desktopCallSurface` pref + surface switching + Calls settings

- `call-prefs-store.ts`: `desktopCallSurface: keep_last | sidebar | floating` (default `keep_last`) + `lastDesktopSurface: sidebar | floating` + `resolveDesktopSurface(pref, last)`; remove the vestigial `dockPosition` if still present.
- `call-dock.tsx`: on desktop, render the resolved surface — `FloatingCallSquare` or `DesktopCallDock` (side). Joining routes to whichever surface is active (both now render joining in-place).
- Wire the **"dock to side"** (square → sidebar, updates `lastDesktopSurface`) and **"float"** (sidebar → square) actions.
- `call-settings.tsx`: a "Desktop video" radio (Keep last / Sidebar / Floating square).
- Tests: resolver matrix, keep_last persistence, dock-to-side/float switch the surface + update last, settings control.
- **NOT**: mobile changes.

## Deferred (do NOT build)

- Mobile floating/PiP.
- Screen-share (two feeds) — its own future stack.
- Server-persisted (cross-device) layout prefs — localStorage only, as today.

## Verification

- Per chunk: Opus implement → Opus xhigh adversarial verify (typecheck + `bun run test:unit` on the touched suites) → fix loop → `/code-review`.
- Whole-stack review after Chunk 4. Real-component screenshots of each surface before merge.
