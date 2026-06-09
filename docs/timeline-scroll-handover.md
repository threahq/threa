# Handover: timeline scroll / keyboard-follow on PR #816 (virtua migration)

**Branch:** `claude/timeline-scroller-scroll-position-0tfsn6`
**PR:** threahq/threa#816 (migrates the message timeline from react-virtuoso → virtua)
**Status:** scroll engine rewritten to a clean single-pin design (commit `d77e4fe`); desktop + initial-load + send-at-bottom behave; **mobile keyboard-follow is still wrong on real Android devices** and the remote session cannot reproduce/measure it.

> **Why this doc exists:** the remote agent (me) cannot run the app on a phone or attach a device debugger, so every mobile fix has been a reasoned guess against staging, tested by the user by hand. That loop is the problem. **You have a local machine and a USB cable — your first job is to get real numbers off the device, not to read more code.** Section 7 is the actual task; everything above it is context.

---

## 1. The goal (the only spec that matters)

The timeline must obey these six rules. They are not independent features — they are all the same thing ("stay glued to the bottom unless the user left"):

1. When the user is flush at the bottom, the last message stays flush (just above the floating composer, never behind it).
2. When a message is added (sent **or** received), it pushes the existing messages up and becomes the new last message — still flush.
3. When dynamic content loads in (link preview image, GIF, avatar decoding late), it pushes older content up; the bottom stays flush.
4. When the composer changes size (focus expands it, blur/clear collapses it), if we were at the bottom the last message stays flush with the composer's new top edge.
5. When the keyboard opens (shrinking the viewport), if we were at the bottom the last message rides up with it and stays flush.
6. If the user has scrolled up **even a little**, we are detached: never change the scroll offset until they return to the bottom.

Rules 1–4 and 6 are working. **Rule 5 (and its interaction with 4) is the open problem on mobile.**

---

## 2. The user's latest report (the symptoms to repro)

Tested on a physical Android phone, Chrome **and** Firefox, against staging. Across the last few iterations the user has reported, in roughly this order (some may now be stale after `d77e4fe` — re-verify):

- Sent message at the bottom is **hidden behind the composer** (not pushed up). _(Should be fixed by `d77e4fe`'s content-shrink guard — verify first.)_
- "Tons of messed-up jumping around" tied to composer resize on focus/blur.
- **The composer itself jumps underneath the keyboard** (newer symptom).
- **Firefox:** first time you focus the composer, the content does **not** follow the keyboard up — until you _close_ the composer, after which it follows. Sometimes seen once on Chrome too. Most recently: "quite consistently doesn't follow on focus at all."
- General sense (correct) that multiple mechanisms were fighting.

The user's exact words: _"it reads like we've got several things fighting each other."_ The `d77e4fe` rewrite was specifically to end that fight (one pin path). It may have fixed some of these; **we do not have a confirmed device retest of `d77e4fe` yet.**

---

## 3. Where the code is

| File                                                         | Role                                                                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/frontend/src/hooks/use-timeline-scroll.ts`             | **The scroll engine.** Owns scroller/list/content refs, follow state, the single pin, the ResizeObserver, the keyboard backstop. Start here.                            |
| `apps/frontend/src/hooks/use-timeline-scroll.test.tsx`       | 15 jsdom tests for the engine (shift detection + follow arm/disarm). All green.                                                                                         |
| `apps/frontend/src/components/timeline/stream-content.tsx`   | Renders the scroller `<div>` + virtua `<Virtualizer>` + `<ComposerFooterSpacer>`. `TimelineMessageList` (~line 1683) is the inner render. Scroller div is ~line 2031.   |
| `apps/frontend/src/hooks/use-visual-viewport.ts`             | Pins `--viewport-height` to the visible viewport; **this is what makes the scroller shrink when the keyboard opens.** Polls every frame for 600ms on focus transitions. |
| `apps/frontend/src/hooks/use-composer-height-publish.ts`     | Publishes `--composer-height` on `[data-editor-zone]`. The footer spacer reads it.                                                                                      |
| `apps/frontend/src/components/layout/app-shell.tsx`          | Root is `height: var(--viewport-height, 100dvh)` (line 216). `useVisualViewport(isMobile)` at line 134.                                                                 |
| `apps/frontend/src/lib/scroll-debug.ts`                      | Opt-in tracing (see §6).                                                                                                                                                |
| `apps/frontend/src/components/timeline/scroll-debug-hud.tsx` | On-screen overlay showing live geometry (see §6).                                                                                                                       |
| `apps/frontend/index.html`                                   | line 7: `interactive-widget=resizes-content` in the viewport meta.                                                                                                      |

---

## 4. The layout / height chain (how the keyboard is _supposed_ to move the tail)

```
AppShell root            <div style="height: var(--viewport-height, 100dvh)">   ← useVisualViewport pins this px value
  └ … flex-1 content
      └ StreamContent     <div class="relative h-full">
          ├ scroller box  <div class="absolute inset-0 overflow-hidden">
          │   └ SCROLLER  <div class="h-full overflow-y-auto" ref=scrollerRef onScroll=handleScroll>   ← we own this
          │       └ content <div ref=contentRef>
          │           ├ Virtualizer (virtua) … messages …
          │           └ ComposerFooterSpacer  height: var(--composer-height)     ← reserves room for the floating pill
          └ COMPOSER      <div class="floating-composer-shell absolute inset-x-0 bottom-0 z-20">        ← floats OVER the scroller
```

Intended keyboard mechanism (no JS scroll math — pure layout):

1. Keyboard opens → `useVisualViewport` shrinks `--viewport-height` → AppShell shrinks → scroller `h-full` shrinks → **scroller `clientHeight` shrinks.**
2. The composer (`bottom-0`) rides up with the shrinking box.
3. The scroll engine's `ResizeObserver` sees the scroller resize → if following, pins `scrollTop = scrollHeight` → last message stays flush above the now-higher composer.

**This entire chain rests on one assumption: that `--viewport-height` actually shrinks, promptly, on the test devices.** That is the thing to verify first (§7).

---

## 5. Current design of the scroll engine (post-`d77e4fe`) and its contract

The rewrite replaced six competing "set scrollTop = scrollHeight" paths + time-window heuristics with **one idempotent pin and one observer**. The two load-bearing ideas:

1. **One pin.** `pinToBottom()` does `el.scrollTop = el.scrollHeight`. Everything that changes geometry while following funnels through it via a single `ResizeObserver(content + scroller)`. They can't fight — same target, idempotent.
2. **Our own pins are invisible to the scroll-up detector.** `pinToBottom()` updates `prevScrollTopRef`/`prevScrollHeightRef` _in the same statement as the write_. So the `scroll` event the pin triggers reads `top === prevTop` → `handleScroll` sees no user movement → follow stays armed. **This is what let us delete all the programmatic time-windows.**

`handleScroll`'s only decision:

- `atBottom` (within `AT_BOTTOM_PX(32) + composerHeight`) → arm follow (unless jump mode). Checked first, so sub-threshold jitter never detaches.
- else `scrolledUp` (`scrollTop < prevTop-1 && scrollHeight >= prevHeight-1`, i.e. moved up and content didn't shrink) **or** a recent user gesture → disarm.

The `scrollHeight >= prevHeight-1` guard is what stops a composer **collapse** (scrollHeight shrinks, browser clamps scrollTop down) from being misread as a user scroll-up — that was the "sent message hides behind composer" bug.

Keyboard backstop (in the ResizeObserver effect): also pins on `visualViewport` `resize`/`scroll` when following, for browsers that change the visual viewport **without** resizing the layout viewport (the scroller). `pinToBottom` is a no-op when not following, so it can't fight.

**What was deleted (do not reintroduce without evidence):** `pinAcrossSettle` (a settle-based rAF loop that pinned out-of-phase with the RO — that _was_ the Chrome bounce), `onMediaLoad`, `programmaticUntilRef`, `viewportSettleUntilRef`, and the runtime composer-height re-pin (now covered by the content RO, because the footer spacer lives inside `contentRef`).

---

## 6. Debugging tools already in the tree

- **On-screen HUD:** open the stream with `?scrolldebug=1` in the URL (persists to `localStorage.threaScrollDebug`). A green monospace overlay (top-left) shows live, sampled every 100ms:
  `follow / dist / ch / sh / st / vvH / vvTop / iH / composer`
  - `follow` = is the tail armed. `ch` = scroller clientHeight. `sh` = scrollHeight. `st` = scrollTop. `vvH` = `visualViewport.height`. `iH` = `window.innerHeight`. `composer` = `--composer-height`.
- **Console tracing:** same flag enables `scrollDebug(...)` → `console.debug("[scroll +Nms] …")`. Logs follow arm/disarm with the geometry that caused it, and every RO pin.
- Both are opt-in and self-contained (`lib/scroll-debug.ts`, `scroll-debug-hud.tsx`) — they are scheduled for removal once the behavior is locked, so feel free to add to them while debugging.

---

## 7. **Your task: measure, then fix**

Do **not** start by editing the hook. Start by getting the real geometry off the device. You can do what the remote session could not:

### Step 1 — Attach a real debugger to the phone

- **Chrome Android:** `chrome://inspect/#devices` on desktop Chrome with the phone on USB + USB debugging on. Inspect the staging tab (or `bun run dev` over the LAN / adb reverse).
- **Firefox Android:** `about:debugging` → This Firefox → connect the device → inspect the tab.
- Run the dev build locally so you can set breakpoints in `use-timeline-scroll.ts` directly. `bun run --cwd apps/frontend dev` (Vite). Use `adb reverse tcp:5173 tcp:5173` so the phone hits your dev server, giving you sourcemaps + live edits.

### Step 2 — Answer these exact questions with `?scrolldebug=1` + the debugger

With a scrollable stream, sitting **flush at the bottom**, then **tap the composer to open the keyboard**, watch the HUD/console and record:

1. **Does `ch` (scroller clientHeight) shrink when the keyboard opens?** (And does `--viewport-height` / `vvH` shrink?) This is the master question.
   - **If `ch` does NOT shrink** → the bug is upstream of the scroll hook: `useVisualViewport` isn't shrinking `--viewport-height` on this device/browser (or the height chain is broken by some CSS). The fix lives in `use-visual-viewport.ts` or the layout, **not** in `use-timeline-scroll.ts`. The vv backstop should still pin in this case — check whether `vvH` shrinks even when `ch` doesn't, and whether the `visualViewport` `resize`/`scroll` listeners fire.
   - **If `ch` DOES shrink** → does `follow` stay `true` through the open, and does `st` track `sh - ch`? If `follow` flips to `false` during the open, something is disarming — find which `scrollDebug("follow DISARMED …")` line fires and what `scrolledUp`/`userGestured`/`dist` were. If `follow` stays true but the tail doesn't move, the RO pin isn't landing — breakpoint in the `ResizeObserver` callback and confirm it fires on the shrink.
2. Repeat for **closing** (blur) the keyboard. Watch for a staged/two-step settle.
3. Repeat for **sending a message while at the bottom** (composer stays focused, text clears → composer shrinks). Confirm the message ends up above the composer and `follow` stays true.
4. The **Firefox "first focus doesn't follow until close"** case: capture the trace across the _first_ focus specifically. Firefox resizes both viewports together (see the comment in `use-visual-viewport.ts`), so the detection path differs. Suspect: on first focus the scroller resize either doesn't fire or fires before virtua/layout settles, and nothing re-pins after. Check whether the `visualViewport` events fire at all on Firefox Android here.

### Step 3 — Fix at the right layer

Only after Step 2 do you know whether this is a **viewport-sizing** problem (`use-visual-viewport.ts` / layout) or a **pin/observer** problem (`use-timeline-scroll.ts`). Resist the temptation to add another pin path — if the RO isn't firing or `--viewport-height` isn't shrinking, more pins won't help and will reintroduce the fighting we just removed.

---

## 8. Ranked hypotheses (for Step 2 to confirm or kill)

1. **`--viewport-height` doesn't shrink (promptly) on the test devices.** Most likely for the Firefox "doesn't follow on focus" case and possibly Chrome. `useVisualViewport` polls for only `POLL_DURATION = 600ms` after focus; if the keyboard animates in slower, or the first `focusin` fires before the OS commits the resize, the poll can finish before the shrink lands and nothing re-measures. → fix in `use-visual-viewport.ts` (longer/observed poll, or drive off `visualViewport` `resize` more aggressively).
2. **The scroller resizes but the `ResizeObserver` pin is a frame late / coalesced**, so the user sees the composer move before the content catches up ("composer jumps under the keyboard"). → the vv backstop should cover this; confirm it's wired and firing.
3. **Something still disarms follow mid-open.** Less likely after `d77e4fe` (we removed the auto-scroll-sensitive paths), but confirm via the `follow DISARMED` trace. If Chrome's `interactive-widget=resizes-content` still auto-scrolls the focused composer and that bubbles a scroll to our scroller, `scrolledUp` could trip — but the composer is a _floating sibling_, not inside the scroller, so Chrome should scroll the document, not our scroller. Verify with the trace before believing it.
4. **`interactive-widget=resizes-content` interacting with `viewport-fit=cover`** in a way that overlays rather than resizes on one browser. Device-specific; the HUD's `vvH` vs `iH` vs `--viewport-height` comparison tells you which model the browser is using.

---

## 9. Constraints / workflow (please honor)

- **Branch:** develop only on `claude/timeline-scroller-scroll-position-0tfsn6`. Do not push elsewhere or open/merge a PR without explicit ask.
- **No model identifiers** in commits/PRs/code/comments.
- **Tests:** `bun run --cwd apps/frontend test src/hooks/use-timeline-scroll.test.tsx`. Keep them green; add a test for whatever you fix. Repo invariants live in the root `CLAUDE.md` (notably INV-39 frontend tests mount real components; INV-22 never dismiss failures as pre-existing).
- **Lint/typecheck** run in the pre-commit hook (full-monorepo `tsc`); commits will block on failure.
- **CodeRabbit** auto-review is paused on this PR due to commit volume (`@coderabbitai resume` to re-enable). Walkthrough webhook updates are no-action.
- **CI deploy** occasionally flakes on a transient Cloudflare KV `Database connection error` (code 10001) during `registerRegion` — just re-run the failed job; it's not the diff.

## 10. What's confirmed working (don't regress these)

- Initial load lands exactly at the bottom, no jump/bounce (cold-load settle is masked behind a skeleton until `scrollHeight` stabilises).
- GIF/link-preview late growth no longer shifts reading position (virtua item resize + content RO).
- Desktop: scroll up to read → does **not** snap back on the next composer resize (the scrollTop-delta disarm catches the scrollbar drag, which fires no gesture event — this was the "Fuck yeah" fix; keep it).
- Send-at-bottom content-shrink guard (composer clears → scrollHeight shrinks → not misread as scroll-up). _Verify on device as part of Step 2.3._
