# Quota carry-on: resuming remote sessions across provider quota windows

Status: first slice shipped (Claude Code channel + Pi remote).

When a linked session's model provider cuts it off — subscription usage limit,
org spend cap, rate limit, overload — the turn dies mid-work. Before this
slice the Claude channel invocation sat silent until the idle reaper closed it
("ended without a reply"), and Pi's auto-retry was deaf to every command while
it waited. Carry-on holds the turn, tells the user when work resumes, lets
them queue instructions for the resume, and types the continuation back into
the session when the quota window reopens.

## Principle

**Provider-specific quota parsing stays in the extension.** Threa (backend,
frontend) only ever sees generic behavior: a turn that stays open, a notice
message, a `/carry-on` slash command. No quota state crosses the wire, no new
tables, no server-side scheduler — the held claim plus an extension-local
timer _is_ the schedule, and it is exactly as durable as the session it would
resume into (if the extension process dies, there is nothing left to resume).

## Claude Code channel

Detection rides the transcript tail the channel already runs for traces
(`transcript-trace.ts`). Claude Code records a dead model call as a synthetic
assistant line flagged `isApiErrorMessage: true`; `extractApiErrorText` pulls
the text and `quota-signal.ts` classifies it:

| Signal (real shapes from local transcripts)                         | Kind             | Action                               |
| ------------------------------------------------------------------- | ---------------- | ------------------------------------ |
| `You've hit your session limit · resets 10:20pm (Europe/Stockholm)` | `quota-reset`    | hold + resume at reset (+45s jitter) |
| `You've hit your org's monthly spend limit · …`                     | `quota-no-reset` | close the turn with an explanation   |
| `API Error: Overloaded`, 5xx, network, server-side rate limiting    | `transient`      | hold + resume in 2min × attempts     |
| policy refusal, model access, prompt-too-long, tool-parse           | `other`          | ignore (not retryable)               |

The reset clause is parsed timezone-aware (`resets [weekday] h:mm am/pm (IANA tz)`)
to an absolute timestamp; an unparseable timezone degrades to `quota-no-reset`
rather than guessing.

`carry-on.ts` (`CarryOnController`) owns the hold:

- **Hold:** keep-alive every 5 min beats the 1h idle reaper; one notice posts
  to the scratchpad with the resume ETA. Claim renewal already runs, so the
  invocation stays claimed server-side.
- **Queue:** `/carry-on <text>` acks and queues; `/steer` during a hold is
  absorbed into the queue (pasting into a quota-dead TUI would just submit a
  prompt that dies the same way); plain messages queued server-side are swept
  in if the user steers.
- **Resume:** at reset the controller pastes a continuation prompt into the
  idle TUI via tmux — same invocation, same trace, queued instructions
  appended. A still-blocked session re-detects and re-holds.
- **Give-up paths** (attempt cap 3, hold cap 8h, no reset time, tmux control
  lost): the turn closes via the normal reply path with a message that carries
  the queued texts verbatim — nothing is dropped silently. `/stop` cancels the
  hold and surfaces any queued texts as a notice.

Fail-safe gating: no tmux control → no controller → detection changes nothing
(previous behavior).

## Pi remote

Pi already auto-retried 429s bearing `Retry-After` (≤3 attempts, ≤4h),
holding the claim with a busy heartbeat. This slice makes the wait navigable:

- `claimIfIdle` no longer goes deaf while waiting: it drains claims, so
  `/stop` cancels the retry (ack says what was dropped), `/carry-on` and
  `/steer` queue text, `/model` remains available as the escape hatch to an
  unthrottled provider, and plain messages fold into the retry prompt with
  steer-sweep semantics (N messages → the one retried response).
- `buildRetryPrompt` appends queued texts to the original prompt when the
  retry fires; `failPending`/`runStopCommand` report dropped queue contents.

## `/carry-on` slash command

One catalog entry (`features/commands/catalog.ts`), advertised by both
runtimes, so the composer menu picks it up with zero frontend changes.
Routing (`resolveRuntimeInvocationRouting`) treats it like `steer`/`stop` —
claimable mid-turn (`session-control` capability for the Claude channel,
`active-scratchpad` for Pi) because its whole purpose is a session blocked
mid-turn. Outside a block both runtimes answer with guidance instead of
queueing into nothing.

## Considered and rejected

- **Cheap-model/background monitor for reset detection** — deterministic
  timers plus re-detection on the next failure need no model call.
- **Backend scheduling** (`scheduled-messages` / queue `processAfter` exist) —
  a server-scheduled resume cannot outlive the extension process it must
  resume into; it adds a second source of truth for no durability gain.

## Follow-ups

- Pi: parse Anthropic `anthropic-ratelimit-*-reset` headers and quota text in
  thrown model errors (`extractModelError` path) for resets without
  `Retry-After`; today those fail the turn after the retry cap.
- Weekly-limit date forms ("resets Oct 21 …") if they appear in the wild —
  the parser currently handles time and weekday+time.
- Quota-aware presence `statusText` for the Claude channel (Pi already shows
  "Rate limited; retrying around HH:MM").
- Lift `CarryOnController` into `@threa/remote-session` when a third runtime
  needs it.
