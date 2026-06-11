---
title: Agent Runtime
status: shipped
audience: internal
kind: subsystem
invariants: [INV-41, INV-28, INV-19, INV-4, INV-20]
entry_points:
  - packages/agent-runtime/src/runtime/agent-runtime.ts
  - apps/backend/src/features/agents/persona-agent.ts
  - apps/backend/src/features/agents/companion/session.ts
  - apps/backend/src/features/agents/companion-outbox-handler.ts
  - apps/backend/src/features/agents/built-in-agents.ts
  - apps/backend/src/features/agents/runtime/session-trace-observer.ts
public_site: false
summary: >
  The loop that runs a persona against a stream: read the conversation, call tools,
  decide whether to reply, write the reply back as a normal message. A host-agnostic
  package holds the loop; the backend feature wires it to Postgres, the outbox, the
  job queue, and the workspace's tools.
related: [public/ai-companions.md, architecture/outbox-pattern.md]
---

## The gist

The agent runtime is what actually runs Ariadne. When a message lands in a stream with
companion mode on, something has to read the conversation, decide whether the agent has
anything to say, let it call tools while it works, and write its reply back as a normal
message in the thread. That loop is the agent runtime.

It is split across two places, and the split is the first thing to understand:

- **`packages/agent-runtime/`** is the host-agnostic core: the loop (`AgentRuntime`), the
  tool-definition framework, the event types it emits, and the AI wrapper (`createAI`).
  It knows nothing about Postgres, the outbox, or HTTP.
- **`apps/backend/src/features/agents/`** wires that core into the product: it resolves the
  persona, builds the tool set from the workspace's integrations, runs the session against
  the database with the right transaction discipline, and turns the loop's events into
  persisted trace steps and socket emissions.

The split exists so the same loop can run inside the enclave for end-to-end-encrypted
streams, over a minimal transport, without bundling the production AI stack. The runtime
only depends on `Pick<AI, "generateTextWithTools">` (`agent-runtime.ts:41`), so an
alternative host can supply just that one method.

A persona is data, not code. `built-in-agents.ts:51` defines Ariadne as a record carrying
its name, avatar, model string, system prompt, temperature, and the list of tools it is
allowed to call. There is a second built-in, the internal "Empty Agent", and the schema
supports workspace-specific personas. The runtime never hardcodes a persona; it takes one
as input and runs it.

## How it works

**Triggering is outbox-driven (INV-4).** A new message does not call the agent directly.
`CompanionHandler` (`companion-outbox-handler.ts:48`) reads `message:created` events off
the outbox, skips persona-authored messages and e2e streams, checks that the stream (or its
root scratchpad, since threads inherit) has `companionMode === "on"`
(`companion-outbox-handler.ts:147`), resolves the persona, and queues a `PERSONA_AGENT` job
(`companion-outbox-handler.ts:224`). Mentions and message edits have their own outbox
handlers (`mention-invoke-outbox-handler.ts`, `message-mutation-outbox-handler.ts`) that
queue the same job, so every path into the runtime is one job type.

**A session runs in three phases, and the AI phase holds no DB connection (INV-41).**
`withCompanionSession` (`companion/session.ts:28`) is the spine:

1. **Setup** is a short transaction that atomically creates or resumes the session row and
   writes the `agent_session:started` event to the outbox. Concurrency is handled by a
   partial unique index (one running session per stream) plus insert-or-skip
   (`session.ts:87`), so two messages racing into the same stream cannot start two agents
   (INV-20).
2. **Work** runs the AI loop with no connection held, just a 15-second heartbeat ticking on
   the pool (`session.ts:137`). This is the slow part, and per INV-41 it must not pin a
   connection.
3. **Completion** is another short transaction that marks the session complete, records the
   response message id and last-seen sequence, and writes `agent_session:completed` to the
   outbox (`session.ts:150`).

**The loop itself is `AgentRuntime.run()` (`agent-runtime.ts:183`).** It emits a
`session:start` event, then iterates up to `maxIterations` (default 20,
`agent-runtime.ts:19`). Each turn calls `generateTextWithTools` with the system prompt,
the conversation, and the tool set. If the model called tools, the runtime executes them
(`executeToolCalls`, `agent-runtime.ts:540`) and loops with the results appended. If it
called no tools, the runtime treats the text as a candidate reply, validates it, and either
commits it through the `sendMessage` callback or loops once more. It ends with `session:end`
or `session:error`.

**Sending a message is a callback, not a side effect the loop owns.** The runtime is handed
a `sendMessage` function (`agent-runtime.ts:64`); the backend's implementation in
`persona-agent.ts` writes the actual stream message, attaches the sources the agent
gathered, and can edit a superseded prior response instead of posting a new one. Personas
have no `stream_members` row, so the message is written with an explicit access scope.

**Traces are events turned into rows.** Everything the loop does (`tool:start`,
`tool:progress`, `tool:complete`, `message:sent`, and so on, defined in `agent-events.ts`)
is emitted to observers. The shared `TraceProjector`
(`packages/agent-runtime/src/runtime/trace-projector.ts`) is the one that matters in
production: it opens a persisted step at `tool:start` so a mid-run refresh shows the
in-progress step, finalizes it at `tool:complete`, and hands persistence to an injected
sink — the backend's `SessionTraceStepSink` (`runtime/session-trace-sink.ts`) pushes rows
and live progress to the socket through `trace-emitter.ts`; the enclave and bot-invocation
surfaces run the same projector over their own sinks. The activity card and the
step-by-step trace the user sees are this stream of rows.

If you only need the mental model, stop here. The rest is the behavior that makes it correct
and safe.

## Details worth knowing

### The agent keeps reading while it works

A companion run is not a single request-response. While the loop is running, new messages
can land in the stream. `NewMessageAwareness` (`agent-runtime.ts:24`) lets the loop check
for messages after its trigger sequence on each turn, inject them, and reconsider its draft
before committing (the `reconsidering` event). This is why a fast follow-up message gets
folded into one reply instead of producing two. Simpler agents leave this hook unset.

### Tool output is treated as untrusted data

Tool results can carry attacker-controlled text (a fetched URL, a GitHub issue body). Before
results go back to the model they pass through `protectToolOutputText`
(`runtime/tool-trust-boundary.ts:46`), which wraps them in a "data only, never instructions"
boundary, flags prompt-injection signals, and redacts things that look like private keys,
API keys, or bearer tokens. This is a defense applied to every tool's output, not a per-tool
opt-in.

### What a persona may see is access-scoped

The agent runs with the access of the _place_ it is invoked in, not workspace-wide and not
(except in one case) the invoking user's. `computeAgentAccessSpec`
(`researcher/access-spec.ts:52`) derives the scope from the stream: a private channel sees
itself plus public streams; a public channel or public scratchpad sees public streams only;
a DM sees the intersection of what both participants can access; only a private scratchpad —
a single-user surface — runs with the invoking user's full access. Context building resolves
that spec to `accessibleStreamIds` (`companion/context.ts:121`), and references to streams
outside the set are stripped before they reach the model
(`companion/strip-inaccessible-refs.ts`). So a companion in one stream cannot quote or
surface content the location is not entitled to see.

### Which tools exist is per-persona, then per-integration

A persona's `enabledTools` list decides which tools are even offered; a `null` list means
all of them, for backwards compatibility (`tool-set.ts`, `tools/index.ts`). On top of that,
a tool only materializes if its dependencies are present: GitHub and Linear tools are built
only when the workspace has those integrations connected, and a persona that lists a GitHub
tool without the integration just logs a warning and the tool is silently absent
(`tool-set.ts:77`). Ariadne ships with web search, URL reading, bounded research, memo
description, and the GitHub and Linear read tools (`built-in-agents.ts:66`).

### Cancellation is cooperative, and only for the long tools

Two cancel channels exist. `shouldAbort` (`agent-runtime.ts:73`) is the hard one: it throws
and kills the session when it has been externally deleted or superseded. `toolSignalProvider`
(`agent-runtime.ts:81`) is the soft one: it hands an `AbortSignal` into a tool's `execute` so
it can return partial results. Today only the long-running research tools wire up the soft
signal; ordinary tools run to completion once started.

### Cost and telemetry ride on every AI call

The runtime forwards a `costContext` (`agent-runtime.ts:61`) and telemetry metadata to every
`generateTextWithTools` call, so usage is attributed to the workspace and to the invoking
user (or to "system" for mention-triggered runs) and recorded for budgets, and each call
carries its function id and model metadata (INV-19). All model access goes through the
`createAI` wrapper, never a raw SDK import (INV-28).

### The enclave runs a stripped-down build

`packages/agent-runtime/src/enclave-runtime.ts` re-exports a minimal slice of the runtime
with no OTEL and no `createAI`, for the enclave to run an e2e-capable persona over its own
transport. Only personas flagged `e2eCapable` (Ariadne, `built-in-agents.ts:95`) can be the
enclave actor; the dispatch gate refuses a non-capable one (`isE2eCapablePersona`). The
enclave-side wiring lives in the enclave service, not here. See e2e-encrypted-scratchpads.

## Boundaries

What does not exist today, stated plainly:

- **No per-stream tool policy.** Tool availability is per-persona (`enabledTools`) and
  per-integration, plus the access-scoping and trust-boundary defenses above. There is no
  table or setting that restricts an agent's tools on a particular stream. (The inventory's
  "per-stream tool privacy policies" phrasing predates this verification; the mechanisms are
  per-persona enablement and per-user access scope, not a per-stream policy.)
- **Workspace persona overrides are code-complete but not surfaced.** A persona's built-in
  config can be patched per workspace (`built-in-agents.ts:148`, `applyBuiltInAgentPatch`)
  and the override repository exists, but no UI sets these and there is no persona picker, so
  companion mode always resolves to Ariadne. See ai-companions for the user-facing side.
- **The Empty Agent is internal.** It is a locked-down shell (`haiku`, zero tools,
  `visibility: "internal"`, `built-in-agents.ts:97`) excluded from the visible-agents list. It
  is not a product-facing companion.
- **Graceful mid-tool cancellation is partial.** Only the research tools honor the
  cooperative abort signal; other tools cannot be interrupted once running.

## Invariants

- **INV-41.** The AI phase of a session holds no database connection: setup and completion
  are short transactions, the loop runs against a heartbeat only (`companion/session.ts`).
- **INV-28.** All model access goes through `createAI`; the runtime depends on a narrowed
  `Pick<AI, "generateTextWithTools">` rather than any raw SDK.
- **INV-19.** Every AI call carries telemetry metadata and a cost context for attribution.
- **INV-4.** Sessions are triggered by outbox events and their lifecycle events
  (`agent_session:started` / `:completed`) are written to the outbox in the same transaction
  as the session-row change, never published ad hoc.
- **INV-20.** Concurrent triggers for one stream cannot start two agents: a partial unique
  index plus insert-or-skip make session creation race-safe.

## Entry points

- `packages/agent-runtime/src/runtime/agent-runtime.ts`: the host-agnostic loop. `run()`,
  the iteration loop, tool execution, new-message reconsideration.
- `apps/backend/src/features/agents/persona-agent.ts`: orchestration. Validates persona and
  stream, builds context, runs the session, implements the `sendMessage` callback.
- `apps/backend/src/features/agents/companion/session.ts`: the three-phase session lifecycle
  and its connection discipline (INV-41).
- `apps/backend/src/features/agents/companion-outbox-handler.ts`: the trigger. Reads
  `message:created`, applies the companion-mode and e2e gates, queues the `PERSONA_AGENT` job.
- `apps/backend/src/features/agents/built-in-agents.ts`: personas as data (Ariadne, Empty
  Agent), the patch schema, and the e2e-capability gate.
- `apps/backend/src/features/agents/runtime/session-trace-observer.ts`: turns loop events
  into persisted trace steps and socket emissions.
