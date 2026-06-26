# Session control for the Claude Code channel (steer / stop / model / run-command)

Status: **implemented** on `feat/harness-steer`, 2026-06-26 (pending live tmux verification — see
checklist). Author: agent session. Command set shipped: `stop`, `steer`, `model`, `compact`, `run`.

Implemented across: backend (`commands/availability.ts`, `commands/handlers.ts`, `commands/catalog.ts`,
`bot-runtimes/service.ts` comment), channel (`claude-code-remote/src/tmux-control.ts` +
`channel-server.ts`), and a harness-CLI bonus (`harness-daemon`: `interrupt`/`steer`/`keys` verbs).
Tests: backend `commands/routing.test.ts`; channel `tmux-control.test.ts` + `session-control.test.ts`
(busy-aware claim caps, command parsing, steer-combine). All green; full typechecks clean. Frontend
unchanged (it was already runtime-agnostic).

## Goal

Give the Claude Code channel runtime the same in-UI session-control slash commands that
the Pi remote runtime already has — `/stop`, `/steer`, `/model`, and the ability to run
arbitrary Claude Code slash commands (e.g. `/compact`, `/remote-control`) — driven from the
Threa composer. Claude Code exposes **no** programmatic control surface to an MCP server, so
the actuator is the tmux pane: the channel sends keystrokes to the pane Claude Code runs in
(the "Ctrl-C-lite" mechanism the harness already uses during spawn). `Escape` = interrupt;
`Escape` + text + `Enter` = steer; `/cmd` + `Enter` = run a slash command.

## What already exists (≈80% of the work is done and runtime-agnostic)

The whole pipeline from composer to a claimed bot-invocation already ships and works for Pi:

- **Frontend is fully generic.** The slash menu (`use-command-suggestion.tsx`), arg picker
  (`use-command-arg-picker.tsx` / `command-arg-picker.tsx`), dispatch
  (`POST /api/workspaces/:id/commands/dispatch` via `commandsApi.dispatch`), optimistic
  `command_dispatched` event, and `/model` value picker all key off `StreamBootstrap.commands`
  (`CommandInfo[]`) + `args[].suggestions`. **`runtimeKind` is never used to gate commands in
  the frontend** (only ref is a presence equality check in `stream-sync.ts:1003`). If the
  backend lists the commands for a stream, the UI lights up automatically. **No frontend change
  is required.**
- **Invocation type + claim path exist.** `bot_invocations.trigger = "session-control"` and
  `requiredCapability` are real columns/enums (`packages/types/src/constants.ts:856-872`). The
  claim SQL (`bot-runtimes/repository.ts:669-711`) has **no server-side busy gate** — a runtime
  can claim an invocation while mid-turn; "one turn at a time" is purely a runtime-side
  convention. Session-control claims skip sealed-context + `agent_session` creation
  (`public-api/handlers.ts:1040,1048`).
- **Targeted delivery exists.** Session-control invocations carry `targetInstanceId` /
  `targetRuntimeSessionId`; the outbox→socket router (`broadcast-handler.ts:209-246`) delivers
  `bot_invocation:available` to the narrow `…:session:{runtimeSessionId}` room, so it reaches
  the exact live instance even when it's busy.
- **The channel already runs in tmux.** `harness-daemon` spawns Claude with
  `tmux new-window … claude …` (`spawners.ts:84-94`) and already uses `tmux send-keys` for the
  boot Enter (`spawners.ts:98`). The channel (an MCP stdio child of Claude) inherits `$TMUX_PANE`.

## The three gaps that gate this to Pi today

1. **Backend target resolver is hard-gated to Pi.**
   `availability.ts:178` — `if (presence.runtimeKind !== BotRuntimeKinds.PI_LOCAL) return null`.
2. **Catalog + capability injection are Pi-named / Pi-only.**
   `PI_SESSION_CONTROL_COMMAND_NAMES` (`catalog.ts:4`), `listPiSessionControlCommandInfos()`
   descriptions say "the linked Pi session", and the bootstrap-default capability injection
   (`bot-runtimes/service.ts:386-407`) adds `supportsSessionControlCommands` only for `pi-local`
   ("the Claude Code channel can't drive the host session" — the assumption we're changing).
3. **The channel neither advertises session-control caps nor has an executor.**
   `channel-server.ts` hello caps = `{ supportsActiveScratchpad, supportsPersistentSessions }`,
   `SUPPORTED_CAPABILITIES = ["active-scratchpad","mentionable"]`, and it does strict
   one-turn-at-a-time (`claimDrain` breaks when `inflight.size > 0`).

## Core mechanism: tmux key injection

The channel resolves its own pane at startup from `process.env.TMUX_PANE` (e.g. `%5`), with an
optional `THREA_TMUX_TARGET` override for tests. Self-discovery beats harness-injection because
the harness picks the window _after_ `claude mcp add`, so the pane id isn't known at registration
time; the env is set by tmux inside the pane and inherited by Claude → the MCP child.

New tiny module `extensions/claude-code-remote/src/tmux-control.ts`:

```ts
const target = process.env.THREA_TMUX_TARGET ?? process.env.TMUX_PANE
export const tmuxAvailable = () => Boolean(process.env.TMUX && target)

function sendKeys(args: string[]) {
  // best-effort; returns ok/err, never throws
  return Bun.spawnSync(["tmux", "send-keys", "-t", target!, ...args])
}
export const interrupt = () => sendKeys(["Escape"])
export const typeLine = (text: string) => {
  sendKeys(["-l", text])
  sendKeys(["Enter"])
}
```

Notes:

- `-l` sends **literal** text so `/`, spaces, and punctuation aren't parsed as tmux key names.
- text then `Enter` are separate, ordered emits (tmux preserves order).
- `Escape` at an idle prompt is harmless, so commands can always interrupt first without needing
  to know whether Claude is busy in the TUI (which the channel can't otherwise detect).

## Command semantics

| Command             | Key sequence                                                                                                   | Channel bookkeeping                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **stop**            | `Escape`                                                                                                       | Complete every in-flight invocation (interrupted), ack the stop invocation: "Stopped Claude."                                                                                                    |
| **steer `<text>`**  | `Escape`, ~250 ms, then forward **one combined** payload through the **existing MCP channel path** (not typed) | Drain all pending msgs for the session + the steer text, combine into ONE turn; complete the interrupted turn + all swept msgs `noResponse`; the primary invocation gets Claude's single `reply` |
| **model `<alias>`** | `typeLine("/model <alias>")`                                                                                   | Ack "Model set to `<alias>`." (best-effort)                                                                                                                                                      |
| **compact**         | `typeLine("/compact")`                                                                                         | Ack                                                                                                                                                                                              |
| **run `<cmd>`**     | `typeLine("/<cmd>")` (strip a leading slash if present)                                                        | Ack "Ran `/<cmd>`."                                                                                                                                                                              |

**Steer is the interesting one.** Rather than blind-typing the steer text into the TUI (where the
result would be orphaned with no invocation to reply to), we use tmux **only** for the `Escape`
interrupt, then push the steer text through the channel's normal
`notifications/claude/channel` notification using the steer invocation's own id. Claude treats it
as a fresh turn and calls `reply(steerId)` → the work round-trips back into the scratchpad. This
is exactly the user's "stop, then send another message," and it reuses the battle-tested
reply/idle-timeout/attachment machinery instead of inventing a parallel path. (A plain follow-up
message with no steer just queues behind the current turn as it does today — steer is the
_interrupt-and-redirect_ variant.)

**Steer combines all pending messages into one turn (mirrors Pi).** Pi drains up to
`STEER_DRAIN_LIMIT` (10) pending invocations while busy: the first becomes `pending`, the rest go
into `steeredInvocations[]`, and on completion the primary gets the final `reply` while **every
swept invocation closes `noResponse`** (`threa-remote.ts:2365-2404`) — N rapid messages → **one**
combined response, not N. The channel reproduces this without a native steer queue: on `/steer`,
after the `Escape`, it drains all currently-pending invocations targeted at the session (plain
messages the user queued while Claude was busy + the steer's own text), **concatenates them
oldest→newest into a single `notifications/claude/channel` payload**, and delivers one turn. The
triggering steer invocation is the primary (registered in `inflight`, receives Claude's `reply`);
the interrupted turn and every swept message complete `noResponse`. Bounded by a drain limit; the
existing `claiming` single-flight guard serialises concurrent steer handlers so rapid `/steer`s
coalesce.

`model` / `compact` / `run` typed mid-turn are buffered by Claude Code's input queue and applied
after the current turn — acceptable, documented. `/model` and other menu-opening commands are
**best-effort**: typing `/model sonnet`+`Enter` can race Claude Code's slash autocomplete. This is
the single biggest live-verify item (see below).

## Concurrency: claiming session-control while a turn is in flight (the crux)

The hard constraint: `/stop` and `/steer` must reach the channel **while it's busy** on a
forwarded turn, but a normal follow-up message must still _wait its turn_ (preserve today's
serialization). These can't be separated by capability today because Pi routes steer/stop to
`active-scratchpad` — the same capability normal scratchpad turns use — specifically so a busy Pi
(which advertises `active-scratchpad` while busy) can claim them.

**Recommended: make `resolveRuntimeInvocationRouting` runtime-kind-aware.**

- `pi-local`: unchanged — steer/stop → `active-scratchpad`.
- `claude-code-channel`: steer/stop → `session-control`.

Then the channel advertises capabilities by busy-state (mirroring Pi's `buildClaimInvocationBody`):

- **idle** (`inflight.size === 0`): `["active-scratchpad","mentionable","session-control"]`
- **busy** (`inflight.size > 0`): `["session-control"]`

Result, with the existing oldest-first claim SQL:

- Busy channel claims **only** session-control invocations (stop/steer/model/…); normal
  follow-ups (`active-scratchpad`) don't match the advertised caps and correctly wait — **today's
  behavior is preserved exactly**, no dependency on Claude Code's mid-turn queueing, no local
  hold-queue.
- `claimDrain` changes from "break if `inflight > 0`" to: loop, claim with busy-appropriate caps,
  execute session-control immediately, forward a normal turn then break.

The routing change is ~5 contained lines (`resolved.runtime.presence.runtimeKind` is already in
scope at the dispatch site, `handlers.ts:140`).

**Alternative (no backend routing change):** keep steer/stop on `active-scratchpad`, have the busy
channel advertise `["active-scratchpad","session-control"]`, claim-and-inspect, and forward any
normal follow-up it grabs mid-turn to Claude (relying on Claude Code to queue it). Lower backend
footprint but changes follow-up serialization and depends on Claude's queueing behavior — not
"rock solid". Recommend the routing-aware option.

## Capability advertisement + graceful degradation

The channel advertises in its `bot:hello` / presence `capabilities` **only when `tmuxAvailable()`**:

```jsonc
{
  "supportsActiveScratchpad": true,
  "supportsPersistentSessions": true,
  "supportsSessionControlCommands": true,
  "sessionControlCommands": ["stop", "steer", "model", "compact", "run"],
  "modelSuggestions": [{ "value": "sonnet" }, { "value": "opus" }, { "value": "default" }, { "value": "opusplan" }],
}
```

`supportedCapabilities` in the hello/claim adds `"session-control"`. If the channel isn't running
inside tmux (no pane), it advertises none of this, so the UI never shows a command that can't be
actuated — fail-safe. `resolveAdvertisedSessionControlCommandNames` (`availability.ts:257`)
already intersects with the canonical name list, so only what the channel advertises shows up.

Commands chosen for v1: **stop, steer, model, compact, run**. Dropped from Pi's set: `thinking`
(no Claude Code slash equivalent), `reload`, `skill` (needs the skill list the channel doesn't
have — fold into generic `run`). `shell` could be added later as a direct exec in the channel
(like Pi's `runShellCommand`), independent of tmux.

`run` is a **new generic command** (arg = slash command to type, e.g. `run /remote-control`). It
must be added to the canonical name list + catalog. Open UX question for Kris: `run` vs surfacing
named passthroughs. The canonical list/identifiers should be renamed
`PI_SESSION_CONTROL_*` → `SESSION_CONTROL_*` (now shared; INV-49 — no deprecated alias) and the
catalog descriptions made runtime-neutral ("the linked session", not "the linked Pi session", per
INV-46).

## Precise change list

**Backend** (`apps/backend/src`)

- `features/commands/availability.ts:178` — widen the gate to allow `claude-code-channel`
  (and rename `resolvePiRuntimeCommandTarget` → `resolveRuntimeCommandTarget`,
  `PiRuntimeCommandTarget` → `RuntimeCommandTarget`).
- `features/commands/handlers.ts:24-44` — `resolveRuntimeInvocationRouting(name, runtimeKind)`;
  claude steer/stop → `session-control`.
- `features/commands/catalog.ts` — rename `PI_SESSION_CONTROL_COMMAND_NAMES` →
  `SESSION_CONTROL_COMMAND_NAMES`, add `run`, neutralize descriptions.
- `features/bot-runtimes/service.ts:386-407` — optional: extend the bootstrap-default capability
  injection to `claude-code-channel` so commands show before the channel's first presence; update
  the now-stale comment. (Belt-and-suspenders; the channel's own hello is the primary source.)

**Channel** (`extensions/claude-code-remote/src`)

- new `tmux-control.ts` (above).
- `config.ts` — read `TMUX_PANE` / `THREA_TMUX_TARGET`; optional `modelSuggestions` config.
- `channel-server.ts` — advertise session-control caps when `tmuxAvailable()`; busy-aware
  `claimBody`; relax `claimDrain` to keep draining session-control while busy; add
  `handleSessionControl(invocation)` dispatching stop/steer/model/compact/run; steer reuses the
  notification + inflight machinery; stop/steer complete interrupted in-flight turns.

**Frontend** — none.

## Risks & live-verify checklist

1. **`$TMUX_PANE` reaches the MCP child.** Confirm Claude Code doesn't scrub env for MCP servers.
   Fallback: harness passes `THREA_TMUX_TARGET` via `claude mcp add --env`.
2. **Single `Escape` interrupts Claude Code** (vs needing double-Esc, which opens history). Tune.
3. **`/model <alias> + Enter` against the slash autocomplete.** Most fragile path. Try literal
   string then short delay then `Enter`; possibly a second `Enter`; confirm `/model sonnet` sets
   directly rather than opening a picker that swallows Enter.
4. **Steer timing** — Claude accepts a new `notifications/claude/channel` immediately after an
   `Escape` interrupt; confirm the ~250 ms delay is enough and the interrupted turn completes
   cleanly.
5. **Busy-claim** — with routing-aware caps, confirm a busy channel claims `/stop` within a frame
   (WS push to the session room) and that a normal follow-up still waits.

Verify with the harness-spawned Claude in tmux + a real scratchpad, watching the pane and the
scratchpad timeline. Unit tests: `tmux-control` (mock `Bun.spawnSync`), `claimDrain` busy-state
capability selection, `handleSessionControl` dispatch + interrupted-turn completion. Backend:
routing-by-kind, target resolver accepts `claude-code-channel`, command list for a channel stream.

## Bonus: harness CLI ergonomics (optional)

To "improve the harness" for manual use, add `threa-harnessd stop|steer|keys <ref> [text]` verbs
that reuse `tmux.ts` against an inventory agent's recorded `tmuxSession:tmuxWindow`. Not on the
Threa-UI path (the channel sends keys directly via its own pane — no cross-process dependency at
runtime), but handy from a terminal.
