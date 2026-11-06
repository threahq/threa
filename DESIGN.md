# Threa — Design Reference

A stable reference for what Threa actually looks and behaves like, grounded in
the running code under `apps/frontend/src/`. Every claim here points to the
file that owns it. If a section drifts from the code, the code wins — fix this
doc and the offending consumer.

This document walks the **real** feature tree: provider stack → shell →
sidebar → timeline → composer → trace → cross-cutting systems. It is _not_ a
clone of `docs/design-system.md`; that doc captures intent and aspirations,
this one captures the system as built.

---

## 0. Feel

Before any of the concrete sections below, the principles that hold Threa
together. New work should _read_ like the rest of the app — these are the
defaults to argue with, not to ignore.

**The thread metaphor.** Threa is named for Ariadne's thread — the line you
follow back out of the labyrinth. The vesica piscis ("needle's eye") with a
single thread passing through it is the brand mark, and the same idea runs
through the product: capture once, hold it, and the thread leads you back.
Visual references to _thread_, _weave_, and _needle_ (the logo, the
`thread-weave` keyframe, the `.thread-glow` utility, the gold accent itself)
are not decoration — they are the load-bearing metaphor. Don't substitute a
generic chat motif.

**Gold on paper, ink for substance.** The palette is deliberately warm and
restrained: a paper-toned canvas (`--background`), ink-toned text
(`--foreground`), and a single gold accent (`--primary`, `38 65% 50%`) that
carries _all_ emphasis — focus rings, active rows, primary actions, the
brand mark, persona accents. There is no blue "info" or green "success" in
the token system; the few hard-coded accents (`URGENCY_COLORS`, bot emerald,
system blue, trace step hues) are signals with specific semantic load — list
in §2.2. If you reach for a new accent color, you are almost certainly
reaching for `--primary` instead.

**Restraint, not minimalism.** Threa is information-dense — power users
spend hours here — but the density comes from tight spacing and quiet
chrome, not from cramming. Use Shadcn primitives. Use the `--radius: 0.5rem`
base. Use lucide stroke icons in `currentColor`. Editorial typography
(serif, italic-for-emphasis, oldstyle figures) is explicitly _not_ used for
functional UI; it reads as decorative on a surface that needs to be
scannable. Switzer + Commit Mono is the entire type system in the app and
the back office; the public site adds one marketing display face (§1.3).

**Motion is short, subtle, and infinite-friendly.** Real durations from
`tailwind.config.js`: entries are `0.2s ease-out` (`fade-in`,
`accordion-down`); the one "satisfying" entry is `thread-grow` at `450ms
cubic-bezier(0.22, 1, 0.36, 1)` (a gentle settle, no overshoot); ambient
loops are `2s ease-in-out infinite` (`activity-pulse`, `ariadne-breathe`,
`topbar-shimmer`). There are no spring physics, no bounce, no flips. The
Ariadne icon "breathes"; the topbar "shimmers"; an arriving message fades
its primary tint to transparent over 2s and disappears. Anything louder
than this is wrong for Threa. Reduced-motion users get every duration
collapsed to `0.01ms` — design every animation as a polish layer, not as
the carrier of meaning.

**Compact is the default for power users.** The timeline ships two
densities (`[data-message-display]`): comfortable (`py-3`, 32px avatar) and
compact (`py-1`, 24px avatar). Both are first-class — neither is a "small
view". When you add a new list-like surface, ask which density it belongs
to and respect that choice. Hints and tooltips must not cause layout shift
(INV-21); a hover affordance that re-flows the row is a bug, not a feature.

**Build with the system, not around it.** Tokens live in `index.css`.
Sidebar urgency colors live in `sidebar/config.ts`. Step colors live in
`step-config.ts`. Actor theming lives in `ACTOR_ROW_THEME`. When you need a
new variant, _extend the config_ and let every consumer pick it up — do not
hand-roll a one-off color or icon at the call site. Drift is the failure
mode this doc exists to prevent.

---

## 1. Identity

### 1.1 Brand marks

Two distinct marks live in code. Do not invent paths.

**Threa logo** — `apps/frontend/src/components/threa-logo.tsx`. Vesica piscis
("needle's eye") with a vertical S-curve thread passing through it. Stroke
only, currentColor → `hsl(var(--primary))` by default.

- Vesica path: `M 50 24 C 64 30, 72 42, 72 50 C 72 58, 64 70, 50 76 C 36 70, 28 58, 28 50 C 28 42, 36 30, 50 24 Z`
- Thread path: `M 50 14 C 47 26, 46 38, 50 50 C 54 62, 53 74, 50 86`
- ViewBox `0 0 100 100`. Stroke widths scale with size (xs–2xl); thicker at small sizes for legibility.
- Wordmark companion (`ThreaLogoWithText`): `font-light tracking-[0.15em] uppercase`. Never bold, never italic.
- `color` prop: `auto` (primary token), `dark` (`#C8A055`), `light` (`#8B7332`).

**Ariadne icon** — `apps/frontend/src/components/ariadne-icon.tsx`. A
stylized heart/thread used as the persona avatar.

- Path: `M 50 18 C 28 18, 20 35, 28 48 C 36 61, 50 55, 50 50 C 50 45, 64 39, 72 48 C 80 57, 72 70, 50 82 C 28 70, 20 57, 28 48`
- Sizes `xs|sm|md|lg` → `14|18|24|32` px. Stroke width inversely scales with size.
- Three states: **static**, **animated** (breathing pulse), **loading** (breathing + whisper ripple — an expanding circle at r=42).
- Uses `currentColor`; inherits theme primary.

### 1.2 Typography

Self-hosted from `apps/frontend/public/fonts/` (no font CDN), declared in
`apps/frontend/src/index.css` and mapped in `tailwind.config.js`:

- **Switzer** — body and UI (`font-sans`). One variable file, weights 100–900; `index.html` preloads it.
- **Commit Mono** — ids, keys, values, code, timestamps that must align (`font-mono`). Static 400 / 500 / 700.

```
sans: "Switzer", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
mono: "Commit Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace
```

User-switchable families (`[data-font-family]`): `system` (default), `monospace`, `dyslexic` (OpenDyslexic, loaded via `<link>` in `index.html`).

User-switchable sizes (`[data-font-size]`): `small` 14px, `medium` 16px, `large` 18px.

Editorial typography (serif, italic for emphasis, oldstyle figures) is
explicitly **not** used for functional UI — chat timestamps and metadata stay
in sans or mono. See feedback memory.

### 1.3 Public / marketing site

The public site (`threa.public-site`) and the app must read as the same
product. That means the marketing surface inherits the app's identity rather
than picking its own.

- **Type family:** Switzer for body and UI, the same file as the app.
  Cabinet Grotesk (variable) is the marketing display face for the hero,
  wordmark and section heads only (`apps/public-site/src/styles/global.css`).
  No serif display headlines, no Newsreader/Fraunces/Inter substitutions.
  Weight variation plus the gold accent is how emphasis is expressed —
  never italic.
- **Mono companion:** Commit Mono, as in the app. Reserve it for meta —
  kickers, timestamps, "/ vetted access" hints — not body copy.
- **Brand mark:** use the exact vesica + thread paths from §1.1 via an
  inline `<symbol id="threa-mark" viewBox="0 0 100 100">`. Do not redraw
  the mark with double ellipses or arcs; do not substitute a wordmark
  for the glyph.
- **Wordmark:** `.wordmark` is Cabinet Grotesk 700 with `-0.01em` letter
  spacing, never italic. The app's `ThreaLogoWithText` keeps its own
  `font-light tracking-[0.15em] uppercase` treatment (§1.1).
- **Color tokens:** lift `--gold`, `--paper`, `--paper-warm`, `--ink`,
  `--ink-soft`, `--night`, `--night-soft`, `--line`, `--muted` from
  `apps/frontend/src/index.css`. Do not introduce competing palettes.
- **Tone of copy:** lead with what Threa is and does (capture, hold,
  return). No anti-competitor framing on the home page. AI is described
  as a utility where it appears, never as the headline subject.
- **Vocabulary:** prefer generic words — chat, notes, memory, hold,
  capture, return, surface, thread. Domain words from the app
  (scratchpads, streams, GAM, Ariadne) belong in deeper product copy,
  not the hero.

---

## 2. Color system

All colors are HSL CSS custom properties. **Source of truth: `apps/frontend/src/index.css`.**
Tailwind utilities read `hsl(var(--token))`. Both light (`:root`) and dark
(`.dark`) values are defined for every token.

### 2.1 Canvas tokens (light → dark)

| Token                                | Light                       | Dark                       | Use                                                                                                      |
| ------------------------------------ | --------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `--background`                       | `40 20% 98%`                | `30 15% 8%`                | App canvas                                                                                               |
| `--foreground`                       | `30 10% 12%`                | `35 15% 92%`               | Body text                                                                                                |
| `--card` / `--popover`               | `40 15% 99%`                | `30 12% 11%`               | Elevated surfaces                                                                                        |
| `--primary`                          | `38 65% 50%`                | `40 55% 55%`               | Golden thread accent                                                                                     |
| `--primary-foreground`               | `40 20% 98%`                | `30 15% 8%`                | Text on primary                                                                                          |
| `--secondary`                        | `35 10% 92%`                | `30 10% 18%`               | Less prominent actions                                                                                   |
| `--muted`                            | `35 12% 93%`                | `30 10% 15%`               | Subdued bg                                                                                               |
| `--muted-foreground`                 | `30 8% 45%`                 | `35 10% 55%`               | Subdued text                                                                                             |
| `--accent`                           | `40 50% 94%`                | `35 25% 18%`               | Hover highlights                                                                                         |
| `--accent-foreground`                | `35 60% 35%`                | `40 45% 70%`               | Text on accent                                                                                           |
| `--destructive`                      | `8 70% 55%`                 | `5 65% 48%`                | Errors / dangerous                                                                                       |
| `--border` / `--input`               | `35 15% 88%`                | `30 10% 20%`               | Lines                                                                                                    |
| `--control` / `--control-foreground` | `38 65% 50%` / `40 20% 98%` | `40 55% 55%` / `30 15% 8%` | Radios, checkboxes, switches. High contrast swaps a darker shade                                         |
| `--ring`                             | `var(--control)`            | `var(--control)`           | Focus rings follow the control colour                                                                    |
| `--muted-foreground-strong`          | `30 8% 38%`                 | `35 10% 64%`               | Muted text inside the settings shell (`SETTING_LEGIBLE_MUTED`), where 11–13px lines need more than 4.5:1 |
| `--radius`                           | `0.5rem`                    | (same)                     | Base radius                                                                                              |

Sidebar gets its own slightly darker canvas: `--sidebar-background`,
`--sidebar-foreground`, `--sidebar-primary`, `--sidebar-accent`,
`--sidebar-border`, `--sidebar-ring`.

Chart palette: `--chart-1..--chart-5` (gold-adjacent ramp).

`--activity-people: 200 60% 50%` — used by sidebar urgency strip for human-activity rows.

### 2.2 Hard-coded accent colors

A small set of colors live as literal HSL strings outside the token system,
because they carry semantic meaning the token system doesn't express:

**Sidebar urgency strip** — `apps/frontend/src/components/layout/sidebar/config.ts`:

```ts
URGENCY_COLORS = {
  mentions: "hsl(0 90% 55%)", // red
  activity: "hsl(210 100% 55%)", // blue
  quiet: "transparent", // hidden
  ai: "hsl(45 100% 50%)", // gold
}
```

**Stream-type badges** — same file:

```ts
BADGE_CONFIG = {
  channel: { icon: Hash, color: "text-[hsl(200_60%_50%)]" },
  scratchpad: { icon: FileEdit, color: "text-primary" },
  dm: { icon: User, color: "text-muted-foreground" },
}
```

**Trace step palette** — `apps/frontend/src/lib/step-config.ts`. 12 step
types, each with `{hue, saturation, lightness}`. See §6.

### 2.3 Accent utilities (`@layer utilities`)

Defined in `index.css`:

- `.thread-gradient` — diagonal background subtly tinted gold.
- `.text-thread` — primary-colored text.
- `.border-thread` — `border-color: hsl(var(--primary) / 0.3)`.
- `.thread-glow` — `box-shadow: 0 0 20px hsl(var(--primary) / 0.15)` (lighter in dark).
- `.input-glow-wrapper` — gold halo on `:focus-within`.
- `.activity-dot` — 8px primary dot; `.recent` triggers `animate-activity-pulse`.
- `.search-highlight mark` — gold highlight on search-result text.
- `.inline-ref` — gold-tinted pill for inline attachment refs in message body.
- `.kbd-hint` — muted bg, mono, 11px — used in quick-switcher footer.

In-stream search uses the CSS Custom Highlight API (`::highlight(stream-search)`
yellow, `::highlight(stream-search-active)` orange), wrapped in `@supports`.

---

## 3. Spacing, radius, motion

- Base radius: `--radius: 0.5rem` (`rounded-lg`; `md` / `sm` step down 2px each). Named radii in `tailwind.config.js`: `rounded-modal` 16px, `rounded-card` / `rounded-input` 12px, `rounded-button` 10px, `rounded-item` / `rounded-avatar` 8px, `rounded-pill` 20px. Settings cards are `rounded-lg`, badges `rounded-full`, sidebar rows `rounded-l-lg` on the urgency-strip side.
- Layout uses Tailwind spacing (`gap-2`, `px-3`, `py-2`); no custom scale.
- Pull-to-refresh has three modes — see §5.
- Reduced-motion users get a CSS class (`.reduced-motion`) that collapses all animation/transition durations to 0.01ms. See `index.css`.

### 3.1 Settings surfaces

Settings (`apps/frontend/src/components/settings/`) are the reference for any
form-like or admin surface. The rules live in `setting-text.ts` and
`setting-primitives.tsx`; reuse those constants rather than restating them.

- **Section:** `SettingsSection` — an uppercase `SETTING_SECTION_HEADING_TEXT` heading (`text-xs font-semibold uppercase tracking-wide text-muted-foreground`) over one card, `rounded-lg border bg-card divide-y`. The card carries the grouping, not extra headings.
- **Rows:** `px-4 py-3`, label left in `text-sm font-medium`, control right. Everything under a label — descriptions, meta, empty notes, errors — is `SETTING_NOTE_TEXT` (`text-[0.8125rem] leading-snug`) in `rem`, so Text size scales it. The settings dialog and drawer set `SETTING_LEGIBLE_MUTED` once (`settings-shell.tsx`), so every muted line inside gets the stronger shade.
- **Group band:** `SettingGroupBand` names a run of rows inside one card (`bg-muted/40 px-4 py-1.5 text-xs font-medium`), not uppercase, so it never reads as a second section.
- **Choices:** `ChoiceSetting`, with `variant` `segmented` for two or three short options (`SegmentedControl`, one radio group: arrow keys move, Tab leaves), `list` when options carry descriptions (the default then), `select` for long lists. Booleans are a `SwitchSetting`.
- **Badges:** `SettingBadge` is an attribute of what it sits on (scope, role, state): `rounded-full border text-xs`, muted, beside a label or after an item's name.
- **Touch:** controls are `SETTING_CONTROL_HEIGHT` (`h-11`, `sm:h-9`, back to 44px on coarse pointers); icon buttons `SETTING_ICON_BUTTON` (44px, 36px on fine-pointer desktops). Below `sm`, rows stack the label over the control instead of shrinking it.
- **Empty:** inside a card, `SettingEmptyNote` (one muted note line). A whole page with nothing to show, such as a search with no matches, gets a dashed `rounded-lg border border-dashed` box with centred text in the card's place; the back office uses that box for every empty, loading and error list.

### 3.2 Back office

`apps/backoffice` is its own Vite app and does not import frontend
components, so it mirrors the system instead of sharing it:

- Same fonts (copied into `apps/backoffice/public/fonts/`), the same colour, control and radius tokens in `src/index.css` / `tailwind.config.js`. Its `--muted-foreground` is the settings shade (`--muted-foreground-strong`) everywhere, because every page is settings-dense meta.
- Layout pieces follow §3.1: `components/layout/section.tsx` (heading + note text), `rows.tsx` (`CARD_CLASS`, `ROW_PADDING`, `RowList`, `LinkRow`, `RowText`, `MetaLine`, `ListPlaceholder`), `stat.tsx`, and one `Page` column (`max-w-5xl`).
- No Radix select, switch or radio group here: `components/ui/native-select.tsx`, `switch.tsx` and `segmented-control.tsx` are native elements styled like their settings counterparts, keeping platform pickers on phones.
- Flag names and descriptions come from `FEATURE_FLAG_COPY` in `@threahq/types`, the same copy the app's settings use; values stay raw, in mono, because admins set exact values.

---

## 4. App composition (provider stack)

The top of every workspace route is **`WorkspaceLayout`** — not "AppShell".
AppShell is a sub-component below the provider tree.

**`apps/frontend/src/pages/workspace-layout.tsx`** wraps the route in (outer →
inner):

```
SyncStatusContext.Provider
└── SocketProvider                  ─ socket.io connection scoped to workspace
    └── WorkspaceSyncHandler        ─ constructs SyncEngine, wires socket lifecycle
        └── CoordinatedLoadingProvider
            └── ChannelLinkProvider
                └── UserProfileProvider
                    └── MentionableMarkdownWrapper
                        └── WorkspaceCommandListProvider
                            └── WorkspaceEmojiProvider
                                └── PreferencesProvider
                                    └── SettingsProvider
                                        └── WorkspaceKeyboardHandler
                                            └── QuickSwitcherProvider
                                                └── PanelProvider
                                                    └── MediaGalleryProvider
                                                        └── TraceProvider
                                                            └── SidebarProvider
                                                                ├── AppShell ▶ <Outlet/>
                                                                └── (dialogs: QuickSwitcher, Settings, WorkspaceSettings, AccountSwitcher, StreamSettings, CreateChannel, AttachmentExplorer, TraceDialog, Toaster)
```

Sibling watchers mounted alongside the tree (no UI of their own):
`UnreadTabIndicator`, `AppUpdateChecker`, `FreshnessWatchers`
(`usePageResumeRefresh` + `useBackgroundBootstrapSync`), `MessageQueueHandler`,
`MentionableWrapper` (bridges user-profile clicks).

### 4.1 SyncEngine

`apps/frontend/src/sync/sync-engine.ts`. One instance per workspace. Owns:

- bootstrap fetches (paired with socket subscriptions — INV-53),
- reconnection refresh,
- workspace-level socket event handlers,
- current-stream-id and visible-stream-ids tracking,
- `handlePageResume` (visibility-resume probe, since `navigator.onLine` doesn't flap),
- `refreshAfterConnectivityResume`.

The engine is held in a `useRef` (not `useMemo`) so StrictMode's effect-cleanup
cycle can't destroy it before the socket connect effect re-runs.

### 4.2 CoordinatedLoading

`CoordinatedLoadingProvider` + `CoordinatedLoadingGate` + `MainContentGate`
gate the visible UI until bootstrap state for the active workspace / visible
streams settles. `AppShell.showLoadingIndicator` surfaces a topbar progress
strip while loading is in flight.

### 4.3 SyncStatusStore

`apps/frontend/src/sync/sync-status.ts`. One instance per workspace,
constructed via `useMemo`, exposed via `SyncStatusContext`. Tracks sync state
per resource (used by the topbar loading indicator and dev-only debug surfaces).

---

## 5. Shell (AppShell)

`apps/frontend/src/components/layout/app-shell.tsx`.

### 5.1 Sidebar states

From the file's own comment:

- **collapsed** — 6px color strip only, 30px hover margin for "magnetic" feel.
- **preview** — user-defined width, positioned `absolute`, doesn't push content (hover state).
- **pinned** — user-defined width, positioned normally, pushes content.

`useSidebar()` exposes `state`, `width`, `isMobile`, `isResizing`, `urgencyBlocks`, plus `setHovering`, `collapse`, `showPreview`, `startResizing`, `stopResizing`, `setWidth`, and `togglePinned`.

### 5.2 Resize / swipe

- Desktop drag handle: `useResizeDrag` (direction `"right"`).
- Mobile: `useSidebarSwipe` for open/close gestures.
- `useVisualViewport` keeps layout in sync with the on-screen keyboard.

### 5.3 Pull-to-refresh

Three explicit modes — `pullModeConfig` in `app-shell.tsx`:

| Mode   | Background         | Foreground              | Label                |
| ------ | ------------------ | ----------------------- | -------------------- |
| `idle` | `bg-muted/50`      | `text-muted-foreground` | "Pull to refresh"    |
| `soft` | `bg-muted/50`      | `text-muted-foreground` | "Release to refresh" |
| `hard` | `bg-orange-500/15` | `text-orange-500`       | "Release to reload"  |

Indicator grows with pull (`28 + progress * 8`px), rotates 0→270°, fades in opacity 0.4→1.0. While refreshing, the icon switches to `text-primary animate-spin`.

### 5.4 Connection status

`apps/frontend/src/components/layout/connection-status.tsx` exports
`useIsOnline()` and a `<ConnectionStatus />` chip rendered in the shell.

### 5.5 Topbar loading indicator

`apps/frontend/src/components/layout/topbar-loading-indicator.tsx`. Thin
progress strip pinned to the top edge while coordinated loading is in flight.

---

## 6. Sidebar

Folder: `apps/frontend/src/components/layout/sidebar/`. Public entry: `sidebar.tsx` → `<Sidebar workspaceId={...}/>`.

### 6.1 Section model

`config.ts` is the single source of truth.

**Smart view** — `SMART_SECTIONS`:

| Key         | Label             | Icon | Sort         | Compact                  | Hover preview |
| ----------- | ----------------- | ---- | ------------ | ------------------------ | ------------- |
| `important` | "Important"       | ⚡   | `importance` | no — full preview always | no            |
| `recent`    | "Recent"          | 🕐   | `activity`   | yes                      | yes           |
| `pinned`    | "Pinned"          | 📌   | `activity`   | yes                      | yes           |
| `other`     | "Everything Else" | 📂   | `activity`   | yes                      | yes           |

**All view** — `ALL_SECTIONS`:

- `scratchpads` → `activity` sort
- `channels` → `alphabetic_active_first`
- `dms` → `alphabetic_active_first`

### 6.2 Stream item

`stream-item.tsx`. Key facts:

- **`UrgencyStrip`** is a `w-1` (1px-equivalent at 4px Tailwind unit) per-row left bar with `rounded-l-lg`, color from `URGENCY_COLORS[urgency]`. Quiet rows render `transparent` (the row still has the strip slot — there is no separate gutter column). Color transitions on a 300ms `transition-colors`.
- **Avatar slot**: 32×32 rounded-lg. Thread-of-DM rows use a special composition: thread icon as main content with the user avatar as a 14px badge overlay in the top-left.
- **Active row**: `bg-primary/10`.
- **Unread row**: `bg-primary/5` (hover `bg-primary/10`).
- **Private channel**: trailing `Lock` icon.
- **Settings/bell hover affordances** ship via `SidebarActionMenu` / `SidebarActionDrawer`.
- **Hover preview** (in compact sections) slides up `-translate-y-[0.3125rem]`.

### 6.3 Tiered reveal

`sections.tsx` exports `TieredStreamSection` with `TIER_VISIBLE_LIMIT = 10`
and a `<MoreDivider>` ("N more" / "less") that toggles the soft cap inline —
no separate "see all" route.

### 6.4 Other sidebar pieces

- `sidebar-header.tsx` — workspace switcher, search affordance.
- `sidebar-actions.tsx` — per-row contextual action menu/drawer.
- `sidebar-footer.tsx` — settings, AI usage, app status, admin portal, and account actions.
- `quick-links.tsx` — top-level nav (Drafts, Saved, Scheduled, Threads, Activity, Memory, Files).
- `scratchpad-item.tsx` — scratchpad-specific row variant.
- `use-urgency-tracking.ts` — drives `urgencyBlocks` exposed by `useSidebar()`.

---

## 7. Routes & pages

`apps/frontend/src/routes/index.tsx`. All non-workspace routes lazy-load their
own chunk (route-level code splitting; heavy deps ride with the page that uses
them). `HydrateFallback: FallbackLoader` is uniform.

Top-level:

- `/` — `RootRedirect`. Reads `getLastWorkspaceId()`; redirects to `/w/:id` or `/workspaces`.
- `/login` — `LoginPage`.
- `/workspaces` — `WorkspaceSelectPage`.
- `/add-account` — `AddAccountPage` (custom social picker; sits in front of AuthKit because hosted UI silent-refreshes).
- `/share` — `ShareTargetPage` (PWA share target).
- `/join/:token` — `JoinPage` (public, unauthenticated invitation claim).

Workspace-scoped (`/w/:workspaceId`):

- `/setup` — `UserSetupPage` (outside WorkspaceLayout — lightweight form, no socket).
- index — `WorkspaceHome` (redirects to last stream or shows "select a stream"; opens sidebar if hint says to).
- `/s/:streamId` — `StreamPage`.
- `/drafts` — `DraftsPage`.
- `/saved/:tab?` — `SavedPage` (URL-driven tabs per INV-59).
- `/scheduled/:tab?` — `ScheduledPage`.
- `/threads` — `ThreadsPage`.
- `/activity/:filter?` — `ActivityPage`.
- `/memory` — `MemoryPage`.
- `/files` — `FilesPage`.
- `/memos/:memoId` — `LegacyMemoRedirect` → `/memory?memo=…`.
- `/share` — `SharePickerPage` (in-app share picker).
- `/admin/ai-usage` — `AIUsageAdminPage`.
- `/app-status` — `AppStatusPage` (build metadata, device readiness, and manual PWA update checks).

---

## 8. Timeline (messages & events)

Folder: `apps/frontend/src/components/timeline/`. The timeline is _event_-shaped, not message-shaped — `EventItem` switches over `event.eventType`.

### 8.1 Event taxonomy

`event-item.tsx` dispatches to:

- `MessageEvent` — `message_created`, `companion_response` (with `DeletedMessageEvent` fallback when `payload.deletedAt` is set).
- `MembershipEvent` — joins/leaves.
- `MessagesMovedEvent` — bulk-move announcements.
- `SystemEvent` — system notices.

Additional rendered surfaces in the same folder:

- `AgentSessionEvent` / `active-bot-status-strip` — live persona/bot activity.
- `CommandEvent` — slash-command echoes.
- `JoinChannelBar`, `UnreadDivider`, `MovedFromIndicator`, `EditedIndicator`.

### 8.2 Actor model — four types, not two

`message-event.tsx`, `ACTOR_ROW_THEME`:

| Actor     | Row accent                                                                                          | Name color         | Badge                                   |
| --------- | --------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------- |
| `user`    | none                                                                                                | inherit            | none                                    |
| `persona` | `bg-gradient-to-r from-primary/[0.06] to-transparent`, `shadow-[inset_3px_0_0_hsl(var(--primary))]` | `text-primary`     | none                                    |
| `bot`     | emerald gradient `from-emerald-500/[0.06]`, inset stripe `hsl(152 69% 41%)`                         | `text-emerald-600` | `BOT` pill, 10px, `text-emerald-600/70` |
| `system`  | blue gradient `from-blue-500/[0.04]`, inset stripe `hsl(210 100% 55%)`                              | `text-blue-500`    | none                                    |

Defaults to `user` when `actorType` is absent.

### 8.3 Density

Two display modes via `[data-message-display]` (driven by Preferences):

- **Comfortable** (default) — `py-3`, `gap-3`, 32px avatar (rounded-lg).
- **Compact** — `py-1`, `gap-2`, 24px avatar (rounded-md). See `index.css`.

### 8.4 Grouping

`groupContinuation` collapses the header row for messages 2..N within a same-author run (5-minute window). Pending/failed/editing states force a full header regardless. `isFirstMessage` triggers the `<MessageContextBadge>` chip on bag-attached scratchpads.

### 8.5 Batch selection

Avatar-as-toggle (Gmail Android pattern). On non-continuation rows the avatar slot doubles as the per-message selection control. Three states (rest / group-hover preview / checked) swap via `display`, not transparency, to avoid stacked-layer "cheap" look. Click anywhere on the row to toggle once batch mode is engaged.

### 8.6 Per-message affordances

- `MessageContextMenu` (desktop right-click), `MessageActionDrawer` / `UnsentMessageActionDrawer` (mobile sheet).
- `MessageReactions` + `ReactionEmojiPicker` + `AllReactionsPopover` + `ReactionDetails`.
- `SaveMessageButton`, `ReminderPickerSheet`, `ReminderPopoverContent`.
- `ThreadSlot` / `ThreadCard` for thread previews and panel mounting.
- `MessageEditForm` / `UnsentMessageEditForm` (inline edits; trigger composer-hide via `body:has([data-inline-edit])`).
- `MessageHistoryDialog` (edit history).
- `ShareMessageModal` for cross-stream share.
- `QuoteReply` + `TextSelectionQuote` for quoting.
- `LinkPreviewList` / `LinkPreviewCard` / `MessageLinkPreviewCard`.
- `AttachmentList` + `PendingAttachments` + the `AttachmentProvider` markdown context.
- `MovedMessagesDrawer`, `MovedFromIndicator`, `MessagesMovedEvent`.
- `SavedIndicator`, `EditedIndicator`.
- `JoinChannelBar` (CTA bar above the composer when viewing a stream you can join).
- Delegation and call cards use `TimelineCardQuickActions` plus one shared action list: mouse users get a floating quick-action cluster, overflow menu, and row right-click menu; touch users long-press the card for a vaul drawer. Keyboard focus reveals the otherwise hidden overflow trigger on touch layouts. Delegation cards keep Copy prompt on the card on mobile. Live call cards keep Join on the card. Interactive controls do not start the row long-press gesture.

### 8.7 Inline edit composer-hide

CSS-based, in `index.css`:

```css
@media (max-width: 639px) {
  body:has([data-inline-edit]) [data-message-composer-root] {
    display: none;
  }
}
```

`body:has()` descends into vaul portals. Visibility is DOM-derived — no React-context drift across hydration races.

### 8.8 In-stream search

`StreamSearchBar` + CSS Custom Highlight API. Yellow for matches, orange for the active match. Falls through cleanly on browsers without `::highlight()` support.

---

## 9. Composer

Folder: `apps/frontend/src/components/composer/`. Entry: `message-composer.tsx`.

The composer is **TipTap (ProseMirror)** wrapped by:

- `RichEditor` — TipTap editor with custom Threa extensions.
- `EditorToolbar` — formatting toolbar.
- `EditorActionBar` — primary action surface (send/format/mic/+/attach/maximize).
- `MicButton` — voice dictation.
- `ContextRefStrip` — pinned context references (`DraftContextRef[]`).
- `PendingAttachments` — upload status row.
- `AttachmentPill`, `MessageContextBadge`, `ScheduledMessagesPicker`, `StashedDraftsPicker`, `FloatingComposerShell`.

### 9.1 Composer document nodes

`editor/editor-extensions.ts` defines the composer schema:

- Text structure: `doc`, `paragraph`, `text`, `hardBreak`, `heading`, `blockquote`, `horizontalRule`, and `codeBlock`.
- Lists and tables: `bulletList`, `orderedList`, `listItem`, `table`, `tableRow`, `tableHeader`, and `tableCell`.
- Inline atoms: `mention` (`attrs.slug`), `channelLink` (`attrs.slug`), `slashCommand` (`attrs.name`), `emoji`, `attachmentReference`, `memoEmbed`, `inAppLink`, and `giphyEmbed`.
- Pill atoms (every inline atom above except `emoji`) reorder by drag. Mouse activation starts after 6px. On touch, a tap selects the whole pill; moving that selected pill by more than 10px starts a drag. An unselected pill leaves pre-hold movement to scrolling, then claims the shared 500ms hold so first-attempt hold-and-move remains reachable; releasing a hold without movement selects the pill instead. The source greys in place while a gold caret snaps between words; touch mirrors that slot in a contextual loupe above the thumb and pulses haptics as the target changes. Release commits one undoable move.
- Selection and copy on a pill are app-owned. Every pill hold belongs to the app's drag gesture, and pills are `user-select: none` in both input modes: Blink resolves a native long press inside a contenteditable against its own heuristics rather than `user-select: all`, so the OS both discards the pill's exact `NodeSelection` and takes the gesture mid-drag. A touch-selected pill instead gets `ComposerPillCopyButton`, a fixed round control above it that writes only that pill's canonical markdown and swaps its icon to a checkmark in place (INV-21, INV-63).
- A range selection dragged across pills is real — copy carries them — but no engine paints the highlight over a `user-select: none` element, so a covered pill looks untouched. The `composer-pill-in-selection` decoration supplies that paint, and the composer's `::selection` uses the same primary wash at the same strength so text and pills read as one range.
- Block atoms: `quoteReply` and `sharedMessage`.

The mobile collapsed bar and board draft affordances both use
`lib/drafts/collapsed-composer-preview.ts`. It gives each schema node a one-line
semantic projection. Its test compares the preview fixture matrix with the node
extensions returned by `createEditorExtensions`, so adding a node without a
preview fixture fails the frontend suite.

### 9.2 Editor styles

`.ProseMirror` rules in `index.css`. Notable:

- `p.is-editor-empty:first-child::before { content: attr(data-placeholder); }` — placeholder rendering.
- Heading sizes: `h1 text-xl/bold`, `h2 text-lg/bold`, `h3 text-base/semibold`.
- `code` — `bg-muted rounded px-1 py-0.5 text-sm font-mono`.
- `pre` — code block with `bg-muted rounded-md p-4 my-2`.
- `blockquote` — `border-l-2 border-primary/50 pl-4 italic text-muted-foreground`.
- Gapcursor overrides — collapses default 0-height, draws a 1px primary caret either side of quote nodes (`.before-quote::after`, `.after-quote::after`), with the caret height bound to `--quote-caret-height` and position computed from `--quote-top` / `--quote-height` / `--quote-right` CSS vars set by the quote node.

### 9.3 Live dictation ghost

While dictating, an in-place hypothesis renders:

- `.dictation-preview-ghost` — `text-muted-foreground/70 italic pointer-events-none select-none`.
- `.dictation-preview-ghost__fresh` — fades the newly arrived tail in over 180ms (`@keyframes dictation-ghost-fade`).
- Empty-state placeholder is suppressed when the ghost is present via `:has(.dictation-preview-ghost)`.
- Reduced-motion disables the fade.

### 9.4 Send modes

Per the type signature (`MessageSendMode` from `@threahq/types`) — surfaced as a "send-mode hint" on the action bar, paired with the `Send` button (`ArrowUp` icon). Other action-bar icons: `X` (close/clear), `Plus`, `AtSign`, `Slash`, `Paperclip`, `Maximize2` (fullscreen — see Composer redesign notes in memory).

### 9.5 Mobile sheet

When the composer is in mobile sheet form, the formatting toolbar row sits above the editor, with a close button and Send in the sheet header. Footer carries draft-saved + word count. (See `composer-redesign.md` memory for the canonical layout.)

---

## 10. Trace (agent reasoning)

Folder: `apps/frontend/src/components/trace/`. Entry: `<TraceDialog />`, gated by `TraceProvider`.

### 10.1 Step taxonomy — 12 types

`apps/frontend/src/lib/step-config.ts` — `STEP_DISPLAY_CONFIG`. Each entry has `label`, `inlineLabel`, `icon` (lucide), `hue`, `saturation`, `lightness`.

| Type               | Label            | Inline label          | Icon            | Hue/Sat/Lit |
| ------------------ | ---------------- | --------------------- | --------------- | ----------- |
| `context_received` | Context          | Reading messages…     | `Inbox`         | 220/70/55   |
| `thinking`         | Thinking         | Thinking…             | `Lightbulb`     | 45/93/47    |
| `reconsidering`    | Reconsidering    | Reconsidering…        | `RotateCcw`     | 280/70/55   |
| `web_search`       | Web Search       | Searching the web…    | `Search`        | 200/70/50   |
| `visit_page`       | Reading Page     | Reading page…         | `FileText`      | 200/70/50   |
| `workspace_search` | Workspace Search | Searching workspace…  | `Building2`     | 270/60/50   |
| `github_access`    | GitHub           | Reading GitHub…       | `Github`        | 210/10/25   |
| `linear_access`    | Linear           | Reading Linear…       | `CircleDot`     | 238/56/60   |
| `message_sent`     | Response         | Sending response…     | `MessageSquare` | 142/76/36   |
| `message_edited`   | Response Updated | Updating response…    | `MessageSquare` | 142/76/36   |
| `tool_call`        | Tool Call        | Using tools…          | `Wrench`        | 200/70/50   |
| `tool_error`       | Error            | Encountered an error… | `AlertTriangle` | 0/72/51     |

Fallback (`getStepInlineLabel(null)`) returns `"Working…"`.

### 10.2 Trace dialog

`trace-dialog.tsx` uses `ResponsiveDialog` (sheet on mobile, dialog on desktop). Features:

- Lineage `<Select>` picker — switch between superseded sessions.
- `<StopResearchButton>` — terminates a running session.
- Six status states: `pending`, `running`, `completed`, `failed`, `deleted`, `superseded`.
- Session duration, rerun-reason summary header.
- `TraceStepList` → `TraceStep` per step.

### 10.3 Inline activity strip

`active-bot-status-strip.tsx` shows current step's `inlineLabel` next to a colored dot whose color is computed from the step's HSL triplet.

---

## 11. Quick switcher (cmdk)

`apps/frontend/src/components/quick-switcher/quick-switcher.tsx`. Three modes:

| Mode      | Prefix | Icon       | Placeholder        |
| --------- | ------ | ---------- | ------------------ |
| `stream`  | (none) | `FileText` | "Search streams…"  |
| `command` | `> `   | `Terminal` | "Run a command…"   |
| `search`  | `? `   | `Search`   | "Search messages…" |

`deriveMode(query)` switches mode by first character. `ModeTabs` lets the user flip mode via UI; `RichInput` parses triggers (`COMMAND_TRIGGERS`, `STREAM_TRIGGERS`, `SEARCH_TRIGGERS`). `ItemList` renders results. Mounted via `ResponsiveDialog`.

The switcher is opened from anywhere via the keyboard shortcuts wired in `WorkspaceKeyboardHandler` (`openQuickSwitcher`, `openSearch`, `openCommands`).

---

## 12. Multi-account & auth

- `apps/frontend/src/auth/` — `useAuth()`, `useUser()`. AuthKit-backed.
- `AccountScopeProvider` — scopes IndexedDB and query cache per signed-in account.
- `apps/frontend/src/components/account-switcher/` — `<AccountSwitcherDialog />`.
- `use-notification-account-switch.ts` — push notifications for a parked account flip the active account in place before deep-link bootstrap.
- `use-resolve-or-bounce.ts` — terminal workspace errors (404/403) try to resolve to another signed-in account that owns the deep link; otherwise bounce to `/workspaces`.

`setLastWorkspaceId(workspaceId)` is the IndexedDB hint that powers PWA cold-start jumping to the workspace last in use.

---

## 13. Dialogs, drawers, popovers

All mounted at the `WorkspaceLayout` level so they can be opened from anywhere:

- `QuickSwitcher`, `SettingsDialog`, `WorkspaceSettingsDialog`, `AccountSwitcherDialog`, `StreamSettingsDialog`, `CreateChannelDialog`, `AttachmentExplorer`, `TraceDialog`, `Toaster`.

`ResponsiveDialog` (`apps/frontend/src/components/ui/responsive-dialog.tsx`) switches Radix Dialog ↔ vaul Drawer based on `useIsMobile()`. Default for any modal surface that needs to behave well on phone.

Radix popper z-index — `body > [data-radix-popper-content-wrapper] { z-index: 60 !important }` — raised app-wide because the WorkOS API-keys widget portals at body level without a scopable attribute. Benign for everything else because Shadcn poppers inside dialogs already need to stack above the `z-50` overlay.

---

## 14. Cross-cutting UI primitives

- Shadcn primitives live under `apps/frontend/src/components/ui/`. Always prefer them (INV-14).
- Icons: **lucide-react only**, stroke-only, currentColor.
- Toasts: **sonner** (`Toaster` mounted at workspace level).
- Mobile sheets: **vaul**.
- Floating positioning: **@floating-ui/react** (under `ui/`).
- Markdown: **react-markdown** in `ui/markdown-content.tsx` plus the `MentionableMarkdownWrapper` + `AttachmentProvider` + `LinkPreviewProvider` context bridges. Code blocks highlight via **shiki** with `themes: { light: "github-light", dark: "github-dark" }` and inline CSS custom properties (`--shiki-light` / `--shiki-dark`) switched by `.dark`.
- Theme: **next-themes**, light/dark only (no system separate from those two on the dark token side).
- Query: **@tanstack/react-query v5**, cache-only observer pattern (`enabled: false` + `queryFn` reading `queryClient.getQueryData`).
- Router: **react-router-dom**, route-level code splitting.

---

## 15. Iconography vocabulary

Lucide icons used in canonical roles. New surfaces should reuse these; introducing a synonym (`SquarePen` vs `FileEdit`, `MessageCircle` vs `MessageSquare`) creates drift.

| Role              | Icon                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| Scratchpad        | `FileEdit`                                                            |
| Channel           | `Hash`                                                                |
| Private channel   | `Lock`                                                                |
| DM                | `User`                                                                |
| Thread            | `MessageSquareText` (sidebar) / `MessageSquareReply` (composer reply) |
| Mention           | `AtSign`                                                              |
| Command           | `Slash` / `Terminal`                                                  |
| Search            | `Search`                                                              |
| Attach            | `Paperclip`                                                           |
| Add / new         | `Plus`                                                                |
| Close / dismiss   | `X`                                                                   |
| Send              | `ArrowUp`                                                             |
| Maximize composer | `Maximize2`                                                           |
| Notifications     | `Bell`                                                                |
| Settings          | `Settings`                                                            |
| Refresh           | `RotateCcw` (reconsider step) / `RefreshCw` (pull-to-refresh)         |
| Saved / done      | `Check`                                                               |
| Quote             | `Quote`                                                               |
| Inbox / context   | `Inbox`                                                               |
| Thinking          | `Lightbulb`                                                           |
| Page              | `FileText`                                                            |
| Workspace         | `Building2`                                                           |
| GitHub            | `Github`                                                              |
| Linear            | `CircleDot`                                                           |
| Tool call         | `Wrench`                                                              |
| Error             | `AlertTriangle`                                                       |

---

## 16. Invariants that shape the UI

Cross-reference; full text in `AGENTS.md`.

- **INV-14** — Shadcn primitives only for foundation components.
- **INV-15** — Components are UI-focused; business logic and persistence live elsewhere.
- **INV-18** — No components defined inside other components.
- **INV-21** — Hints/tooltips/popovers must not cause layout shift.
- **INV-40** — Navigation is `<Link>`; actions are `<button>`.
- **INV-42** — User-facing dates render in device local time via `lib/dates.ts`. The `prefs?: TimePrefs` argument is for non-UI contexts only.
- **INV-46** — No hardcoded display text in backend responses; format in frontend.
- **INV-53** — Socket subscriptions pair with bootstrap fetches; bootstrap is invalidated on reconnect/resubscribe.
- **INV-58** — `contentJson` (ProseMirror JSONContent) is the canonical internal representation; markdown is wire format only.
- **INV-59** — Multi-view pages derive active view from the URL, not `useState`. Use `/saved/done`, not `?tab=done`.
- **INV-60** — Preview surfaces strip markdown via `stripMarkdownToInline()` or `truncateContent()` before rendering. Never pass raw markdown to a `<span>`.

---

## 17. Maintenance

- **Source of truth is the code.** When adding a new step type, sidebar urgency level, actor type, badge variant, etc., update the config file in code first (`step-config.ts`, `sidebar/config.ts`, `ACTOR_ROW_THEME`, etc.). Then update this doc to match.
- **`docs/design-system.md` describes intent.** Some of its claims drift from the code. Use it for vocabulary and motivation, not for implementation details.
- **An HTML companion (`docs/DESIGN.html`) is intentionally absent.** A future companion should be _generated_ from the real config (`URGENCY_COLORS`, `STEP_DISPLAY_CONFIG`, `ACTOR_ROW_THEME`, `BADGE_CONFIG`, `SMART_SECTIONS`) rather than hand-authored, so it can't drift.
