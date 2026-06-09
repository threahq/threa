# Handover: timeline scroll pinning (PR #816)

**For:** a local agent with computer-use / browser capabilities.
**Branch:** `claude/timeline-scroller-scroll-position-0tfsn6` (PR #816, base `main`).
**Primary file:** `apps/frontend/src/hooks/use-timeline-scroll.ts`
**Companion:** `apps/frontend/src/components/timeline/stream-content.tsx` (renders the scroller + virtua).

This was developed in a remote (no-browser) environment, so every fix was
reasoned + shipped to staging for the human to test on a real phone. Two
symptoms persist that we cannot reproduce without a real device/emulator and DOM
inspection. That's why this is being handed to you — **you can actually run the
app, open the on-screen keyboard, and inspect `scrollTop`/`scrollHeight`/
`--composer-height`/`--viewport-height` live.** Please do that before changing
code.

---

## 1. What this PR is and why

Threa's message timeline (channels + scratchpads) was built on **react-virtuoso**.
Virtuoso freezes/owns its own scroll position, which caused two long-standing
miseries:

- **Reverse-infinite-scroll jump:** loading an older page (prepend) jerked the
  viewport.
- **Media reflow jump:** an off-screen image/gif/link-preview above the fold
  finishing layout shifted the reading position.

This PR migrates the timeline to **virtua** (`virtua@0.49.1`, `Virtualizer`) with
a **scroll container we own** — a plain `overflow-y-auto` `<div>`. All scroll
decisions (at-bottom, follow-the-tail, jump-to-latest, keyboard) read native
`scrollTop / scrollHeight / clientHeight` in our hook, with no library
tug-of-war. The one thing delegated to virtua is the hard part: holding the
viewport from the end when an older page is prepended (`shift` prop), plus
re-pinning on individual item resize.

The migration itself works well and the human is happy with general scrolling.
**Two edge behaviors are still wrong** (section 3).

---

## 2. Current architecture (read this before touching anything)

### DOM (from `stream-content.tsx`, the `useVirtualized` branch ~line 1988)

```
<div ref={scrollerRef}                       ← THE SCROLLER (overflow-y-auto, h-full)
     onScroll={handleScroll} style={{ overflowAnchor: "none" }}>
  <div ref={contentRef}>                       ← inner content wrapper (full scroll height)
    <div ref={topSpacerRef}>…header spacer…</div>
    <Virtualizer ref={listRef} scrollRef={scrollerRef} startMargin={…} shift={shift}>
      {visibleItems.map(… <TimelineItemContent/> …)}
    </Virtualizer>
    <ComposerFooterSpacer />                    ← <div style={{height: var(--composer-height,0px)}}>
  </div>
</div>
```

The **composer** (message input pill) is a separate `position: absolute; bottom-0`
element (`FloatingComposerShell`) that floats *over* the bottom of the scroller.
The `ComposerFooterSpacer` reserves matching empty space at the end of the scroll
content so the last message can rest *above* the floating composer instead of
behind it.

### The two CSS custom properties that matter

- **`--composer-height`** — published by `useComposerHeightPublish`
  (`apps/frontend/src/hooks/use-composer-height-publish.ts`) onto the nearest
  `[data-editor-zone]` ancestor, via a `ResizeObserver` on the composer. The
  footer spacer reads it. It is **persisted** (`lib/composer-height-storage.ts`)
  so it can be set on mount, but the composer's *real* measured height can differ
  (cold boot, restored draft, density/zoom) and arrives a few frames later.
- **`--viewport-height`** — published by `useVisualViewport`
  (`apps/frontend/src/hooks/use-visual-viewport.ts`) onto `document.documentElement`,
  pinned to `window.visualViewport.height`. **AppShell is sized to it**
  (`apps/frontend/src/components/layout/app-shell.tsx:216`:
  `style={{ height: "var(--viewport-height, 100dvh)" }}`). On mobile the soft
  keyboard shrinks `visualViewport` → `--viewport-height` shrinks → AppShell
  shrinks → the timeline scroller (an `h-full` descendant) shrinks. The hook
  **polls** `visualViewport` for `POLL_DURATION = 600ms` across focus transitions
  because the keyboard animates and doesn't emit a clean single resize.

### The hook's model (`use-timeline-scroll.ts`)

- `isFollowingTailRef` — are we parked at the live tail (auto-follow new output)?
- `handleScroll` (on the scroller's `onScroll`): computes
  `distanceFromBottom = scrollHeight - scrollTop - clientHeight`; `atBottom =
  distanceFromBottom <= AT_BOTTOM_PX(32) + readComposerHeight(el)`; sets follow =
  atBottom && !jumpMode; toggles the jump-to-latest pill at `> 600px`.
- `snapToBottom()` = `scrollTop = scrollHeight` (browser-clamped to the true max,
  which **includes** the footer spacer → last message lands above the composer).
  This is the "jump to latest" button path and the human confirms **it works
  flawlessly**.
- **Initial scroll** (`useLayoutEffect`): `scrollToIndex(last, { align:"end",
  offset: readComposerHeight })` to force virtua to render+measure the bottom on
  a cold load (otherwise unmeasured items make `scrollHeight` an underestimate
  and we land "pages up"), then `snapToBottom()`. The `offset` is because
  virtua's `scrollToIndex` aligns the *item* (ignores the trailing footer
  spacer); passing the composer height makes it target the footer-inclusive
  bottom. (Confirmed in virtua source: `scrollToIndex` sets `scrollTop = offset +
  itemOffset + itemSize - viewport` and lets the **browser** clamp — it does not
  clamp to its own content, so the offset survives.)
- **ResizeObserver** on `scroller` + `content`: while following → `scrollTop =
  scrollHeight` (re-pin). While reading → compensate a viewport delta. This is
  the signal that fires on composer/editor resize and **works** (see §3).
- **visualViewport `resize`**: while following, re-pin **every animation frame**
  for `VIEWPORT_SETTLE_MS = 600ms`, holding follow armed throughout (keyboard
  tracking).
- **`programmaticUntilRef`**: a short window during which `handleScroll` must NOT
  disarm follow — our own snaps transiently read "not at bottom" while content
  is still growing underneath, and disarming there was what stranded the list.

---

## 3. What is still NOT perfect (the two open bugs)

Tested by the human on a real Android phone against staging. Both still wrong on
the latest commit (`df30c54`).

### Bug A — initial load / stream-switch lands slightly too low ("off by a bit")

On cold load or switching streams, the timeline lands with the last message
**~a composer height too low** — partially behind the floating composer. It used
to land "a couple pages up" (much worse); the `scrollToIndex` + offset work got
it close, but it's still off by a small amount. The human's read: *"it smells of
timing — the editor seems to be calculated as 0 size and then we add/subtract
some pixels which pushes content down a bit more."*

### Bug B — opening the mobile keyboard does not move the bottom up

When parked at the bottom and you focus the editor, the keyboard opens (and the
composer grows its toolbar), but the content does **not** scroll up to keep the
last message above the keyboard — it stays put, hidden behind the composer/
keyboard.

### The single most important clue

> **"When the editor is resized it DOES snap back properly. If I type a newline
> (which grows the composer) while at the bottom, things snap perfectly into
> place."**

So the **content `ResizeObserver` → `scrollTop = scrollHeight` path works
correctly** when `--composer-height` changes *after* layout has settled. The
failing paths (initial load, keyboard) both fire their snap **before** the
relevant size has settled (composer not yet measured on cold load; viewport
mid-animation on keyboard). This is a **timing/ordering** problem, not a math
problem — the math is proven correct by the working editor-resize path.

---

## 4. What we already tried (don't repeat these)

Chronological; each shipped + tested:

1. **`scrollToIndex(last, "end")` only** → fixed "pages up" but landed the last
   message at the viewport edge *behind* the composer (ignores footer spacer).
2. **`scrollTop = scrollHeight` only (no scrollToIndex)** → regressed to "pages
   up": virtua never rendered the bottom, so `scrollHeight` was an estimate.
3. **`scrollToIndex` + `scrollTop=scrollHeight` together** → they fought:
   scrollToIndex re-applies its item-aligned target across frames as items
   measure, overriding the pin; landed ~composer-height low.
4. **At-bottom allowance** (`atBottom <= 32 + --composer-height`) → correct and
   kept; stops follow disarming when only the footer spacer is below the fold.
   Necessary but not sufficient.
5. **`scrollToIndex(last,{align:"end", offset:composerHeight})`** → targets the
   footer-inclusive bottom so it converges *with* the pin. Helped, still "off by
   a bit" → strongly implies `readComposerHeight()` returns the *wrong/stale*
   value at the instant of the initial layout effect (e.g. 0 or the persisted
   value, not the real measured one).
6. **visualViewport re-pin, single rAF** → no effect on keyboard.
7. **visualViewport re-pin, every frame for 600ms + hold follow armed** → still
   no effect on keyboard (current state).

### The leading hypotheses to verify FIRST (with the DOM open)

- **Bug A:** at the moment the initial `useLayoutEffect` runs,
  `getComputedStyle(scroller).getPropertyValue("--composer-height")` is probably
  **0 or stale**, so the `offset` is wrong and the post-composer-measurement
  re-pin (content RO) either doesn't fire or fires but is then undone. *Instrument
  it:* log `--composer-height`, `scrollTop`, `scrollHeight`, `clientHeight` at:
  the layout effect, every content-RO fire, and after the composer's first real
  measurement. See whether the RO snap actually runs and whether something writes
  `scrollTop` afterward.
- **Bug B:** confirm empirically whether the **scroller's `clientHeight`
  actually shrinks** when the keyboard opens (set a breakpoint / log in the RO).
  AppShell *is* sized to `--viewport-height`, but there may be a fixed-height or
  non-`h-full` ancestor between AppShell and the scroller that eats the shrink,
  OR `useVisualViewport(isMobile)` may be gated off / the device may overlay the
  keyboard without resizing. If the scroller does **not** shrink, no amount of
  `scrollTop=scrollHeight` helps (content is already at the bottom, behind the
  keyboard) and the fix is different: **grow the footer spacer by the keyboard
  overlap** (`window.innerHeight - visualViewport.height`) so the content rises —
  i.e. reuse the proven editor-resize mechanism instead of re-pinning.

The whole point of handing this to a computer-capable agent: **stop guessing,
measure.** Put the numbers next to each event and the root cause should be
obvious within one session.

---

## 5. Reproducing locally — seed a channel with ~200 messages

You need a channel with enough variable-height content (text, long messages,
images/gifs/link-previews) that virtua's estimate→measure convergence and the
composer-spacer math are actually exercised. ~200 messages is plenty.

### 5a. Create the channel (UI — there is no create-stream API endpoint)

Run the app locally (or use staging), create a channel via the UI, and copy the
workspace + stream IDs straight out of the URL:

```
…/w/<workspaceId>/s/<streamId>
       ^^^^^^^^^^^      ^^^^^^^^
```

### 5b. Seed messages via the public API (staggered to dodge the rate limiter)

The public API is at `/api/v1`. See the `threa-public-api` skill / the routes in
`apps/backend/src/features/public-api/routes.ts`. Key facts:

- **Send:** `POST /workspaces/{ws}/streams/{stream}/messages`, body
  `{ content (markdown), clientMessageId (idempotency), metadata? }`.
- **Auth:** `Authorization: Bearer <key>`. A staging write key is in the env as
  `$THREA_STAGING_TOKEN`; for local dev, mint/point at your local key + base URL.
- **Rate limits:** **60 req / 60 s per key**, 600 / 60 s per workspace. Pace at
  **≥1.5 s between requests** (~40/min) and back off on HTTP **429**. 200 msgs ≈
  5 min. `content` is markdown — bare image/gif URLs unfurl into preview cards
  server-side, which is exactly the tall, late-measuring content you want.

Save as `scripts/seed-timeline.ts` and run with `bun scripts/seed-timeline.ts`
(it reads config from env so no secrets are committed):

```ts
// bun scripts/seed-timeline.ts
// Env: THREA_BASE_URL, THREA_WS, THREA_STREAM, THREA_TOKEN
const BASE = process.env.THREA_BASE_URL ?? "https://staging.threa.io"
const WS = process.env.THREA_WS!
const STREAM = process.env.THREA_STREAM!
const TOKEN = process.env.THREA_TOKEN ?? process.env.THREA_STAGING_TOKEN!
const COUNT = Number(process.env.COUNT ?? 200)
const GAP_MS = Number(process.env.GAP_MS ?? 1600) // ≥1.5s → under 60/60s

if (!WS || !STREAM || !TOKEN) throw new Error("Set THREA_WS, THREA_STREAM, THREA_TOKEN")

const url = `${BASE}/api/v1/workspaces/${WS}/streams/${STREAM}/messages`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Mix heights: short lines, long paragraphs, and media that unfurls (tall, late
// to measure — the case that stresses virtua's estimate→measure convergence).
const GIFS = [
  "https://media.giphy.com/media/3o7TKsQ8UQ0Mnsl9Pq/giphy.gif",
  "https://media.giphy.com/media/l0HlvtIPzPdt2usKs/giphy.gif",
]
function body(i: number): string {
  if (i % 12 === 0) return GIFS[i % GIFS.length] // unfurls to a tall card
  if (i % 7 === 0) return `Message ${i}\n\n` + "lorem ipsum dolor sit amet ".repeat(20)
  if (i % 5 === 0) return `**Message ${i}** with some _markdown_ and a https://github.com link`
  return `Message ${i} — short line`
}

let sent = 0
for (let i = 1; i <= COUNT; i++) {
  let attempt = 0
  for (;;) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ content: body(i), clientMessageId: `seed-${STREAM}-${i}` }),
    })
    if (res.status === 201) { sent++; break }
    if (res.status === 429) {
      const backoff = Math.min(32000, 2000 * 2 ** attempt++)
      console.warn(`429 at #${i} — backing off ${backoff}ms`)
      await sleep(backoff)
      continue
    }
    console.error(`#${i} failed: ${res.status} ${await res.text()}`)
    break
  }
  if (i % 10 === 0) console.log(`sent ${sent}/${COUNT}`)
  await sleep(GAP_MS)
}
console.log(`done: ${sent}/${COUNT}`)
```

`clientMessageId` makes re-runs idempotent (no double-posting). Bump `COUNT` /
tweak the height mix as needed. Make sure several **tall** items (gifs, link
cards) land near the **bottom** of the stream — that's where the cold-load
estimate error and the composer-spacer math bite hardest.

---

## 6. How to verify a fix (the four cases)

Test on a **real mobile device or an emulator with a working soft keyboard** —
desktop DevTools "device mode" does **not** open an OS keyboard, so it will not
reproduce Bug B (no `visualViewport` shrink). For Bug A, a narrow viewport +
many messages on desktop is enough.

1. **Cold load:** hard-refresh on the seeded channel → the **last** message must
   rest just **above** the composer (not behind it), first paint, no visible
   creep/jump.
2. **Stream switch:** navigate away and back → same as cold load.
3. **Keyboard open:** parked at the bottom, focus the editor → the last message
   must rise and stay **above** the keyboard+composer as the keyboard animates in.
4. **Regressions to NOT break:** slow scroll up through several pages of older
   messages (no jump when a page prepends or when an above-fold gif loads);
   the **jump-to-latest button** (must stay flawless); deep-link to a message
   (`?m=…`) must anchor on the target and not yank to the tail.

Instrument with something like:

```js
const s = document.querySelector('[ref=scrollerRef]') // or the overflow-y-auto timeline div
const log = () => console.log({
  scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight,
  distanceFromBottom: s.scrollHeight - s.scrollTop - s.clientHeight,
  composer: getComputedStyle(s).getPropertyValue('--composer-height'),
  viewport: getComputedStyle(document.documentElement).getPropertyValue('--viewport-height'),
})
new ResizeObserver(log).observe(s)
window.visualViewport.addEventListener('resize', log)
```

---

## 7. Guardrails

- Repo invariants live in root `CLAUDE.md` and `apps/frontend/CLAUDE.md`. Notable
  here: components stay UI-focused (INV-15), Shadcn primitives (INV-14), no
  layout-shift hints (INV-21), don't add speculative config (INV-36).
- Tests: `bun run test` (unit/integration). The hook's tests are
  `apps/frontend/src/hooks/use-timeline-scroll.test.tsx` (a probe-component
  harness that drives `handleScroll`/`scrollToBottom` against a fake scroller
  div). Timeline component tests: `apps/frontend/src/components/timeline/`. Add a
  failing test for the timing bug if you can express it in jsdom (note: jsdom has
  no real layout, so `scrollHeight`/RO timing can't be fully reproduced there —
  the existing tests fake the div metrics).
- Run `bunx tsc --noEmit` + `bunx eslint` + `bunx prettier --write` on touched
  files before committing. CI (11 checks, incl. browser-tests) must stay green.
- Commit to the branch above; the PR auto-reviews via CodeRabbit.
- **Don't** force `prefs.timezone` into UI date rendering, and **don't** reach
  for `mock.module()` in tests (INV-48) — use scoped `spyOn`.

---

## 8. TL;DR for the next agent

The general virtua migration is solid. Two timing bugs remain, and the proof
that it's *timing* (not math) is that **a manual editor resize snaps perfectly**.
Open the app on a device/emulator, seed a channel (§5), put `scrollTop /
scrollHeight / clientHeight / --composer-height / --viewport-height` side-by-side
on a timeline at each relevant event (§4 hypotheses), and you'll see exactly
which snap fires against a stale/zero size or against a scroller that didn't
shrink. Fix that one ordering, reusing the working content-ResizeObserver path
rather than adding more eager snaps.
