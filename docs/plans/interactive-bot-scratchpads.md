# Interactive bot scratchpads and mentions

## Problem

Threa's scratchpad experience currently treats Ariadne as a special active companion: when companion mode is enabled, she responds automatically in the scratchpad and in scratchpad-rooted threads. That works for the built-in assistant, but it does not generalize cleanly to user-owned bots such as a user-named Hermes-backed bot (for example `@hermit`), an OpenClaw-backed coding agent, or a local Pi bridge.

Personal bots now have the backend foundation to be user-owned and tagged with capability traits, but a single coarse `interactive` trait would not be enough for the product model Threa needs:

- mentioning an owned bot anywhere the user is allowed to talk,
- creating a dedicated chat scratchpad for a user-named bot where that bot responds without being mentioned every time,
- invoking Ariadne or another bot inside that same scratchpad when explicitly mentioned,
- keeping the same behavior in threads under the scratchpad,
- routing those invocations to provider-specific runtimes without making Threa know whether the other side is Hermes, OpenClaw, Claude Code channels, or a custom Pi adapter.

This note describes the product/runtime contract only. It intentionally contains no implementation. For a concrete staged implementation plan focused on the local Pi remote adapter, see [`pi-remote-protocol-implementation.md`](./pi-remote-protocol-implementation.md).

## Product direction

Bot interactivity should be split into separate capabilities instead of overloading one `interactive` trait for every conversational use case:

1. **Mentionable** — an actor can be explicitly invoked with `@slug` for a one-shot response in the current context. This is how Ariadne works outside scratchpads today.
2. **Active scratchpad participant** — an actor can be selected as the primary participant in a dedicated scratchpad and responds to normal user messages without requiring an `@mention`. This is the "Chat with <bot name>" experience.

Ariadne has both capabilities: she can be mentioned from arbitrary contexts, and she can be active in scratchpads. A user-owned bot should be able to support either one or both, depending on what its runtime can safely provide.

## Capability granularity

The capability split matters because the integration requirements are different:

| Capability          | User experience                                                                               | Runtime requirements                                                                                             | Good fit                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `mentionable`       | User writes `@bot ...`; bot answers once in this context                                      | Resolve mention, create one invocation, read bounded context, post a reply                                       | Stateless helpers, PR/status bots, local tools that should not become ambient chat partners |
| `active-scratchpad` | User opens a dedicated bot chat scratchpad; bot responds turn-by-turn without being mentioned | Persistent session binding, runtime presence, concurrency policy, thread inheritance, in-flight message handling | Ariadne-style companions, Hermes/OpenClaw/Pi coding sessions                                |

The exact stored trait names are still provisional, but the recommended direction is to make both explicit (`mentionable`, `active-scratchpad`) so the product does not rely on implicit hierarchy. A fully interactive chat bot would normally have both traits, while a mentionable-only bot would not appear as a dedicated scratchpad companion.

## Vocabulary

**Interactive actor**

Umbrella term for a persona or bot with at least one conversational capability. Ariadne is a persona; personal/shared bots can become interactive actors when they carry `mentionable`, `active-scratchpad`, or equivalent traits.

**Mentionable actor**

A persona or bot that can be invoked by explicit `@slug` mention for a one-shot response in the current stream/thread context.

**Active-capable actor**

A persona or bot that can be attached to a scratchpad as the primary participant and respond without being mentioned on every turn.

**Active actor**

The primary active-capable actor attached to a scratchpad. The active actor is invoked automatically for ordinary user messages in that scratchpad and its descendant threads.

**Mention invocation**

A one-off invocation created by an explicit `@actor` mention. Mention invocations should work in any stream where the user can write and the actor is available to that user.

**Runtime adapter**

The process/plugin/API bridge that turns a Threa invocation into work performed by Hermes, OpenClaw, Claude Code, local Pi, or another runtime.

**Runtime session binding**

The adapter-owned mapping from a Threa conversation surface to a runtime session:

```text
workspaceId + rootStreamId + activeStreamId + actor.id → runtimeSessionId
```

For a top-level scratchpad, `rootStreamId` and `activeStreamId` are the same. For a thread under that scratchpad, `rootStreamId` stays the scratchpad and `activeStreamId` is the thread. This mirrors Ariadne's current behavior: the scratchpad's companion is inherited into scratchpad-rooted threads, but the response lands in the current thread.

## User-facing behavior

### 1. Mention your own bot anywhere

A user who owns a personal mentionable bot should be able to mention it by its user-chosen slug. For example, if the user created a bot named Hermit with slug `hermit`:

```text
@hermit can you look at this thread and summarize the plan?
```

Expected behavior:

- Threa resolves `@hermit` as that user's personal bot.
- If the current stream is a top-level channel, the bot response should follow existing Ariadne mention behavior and happen in a thread for that message.
- If the current stream is a scratchpad, DM, or thread, the bot responds in the current stream.
- The bot invocation is scoped to the current stream/thread context and must not grant hidden workspace-wide access.

### 2. Create a dedicated bot chat scratchpad

When the user creates a scratchpad with an active-scratchpad-capable bot selected, that bot becomes the active actor for the scratchpad.

Expected behavior:

```text
User creates "Chat with <bot name>" (for example, "Chat with Hermit")
  ↓
The selected bot is attached as the active actor
  ↓
User sends "hiya"
  ↓
The selected bot responds without requiring @slug
```

This is intentionally different from a passive mention-only participant. Requiring `@slug` on every message in a dedicated bot chat scratchpad would make the scratchpad feel broken.

### 3. Mention Ariadne inside another bot's scratchpad

The active actor should not prevent explicit mention invocations of other actors.

Example:

```text
User, in a scratchpad whose active actor is their bot:
@ariadne can you sanity-check this plan?
```

Default activation rule:

- Because the message explicitly mentions `@ariadne`, Threa invokes Ariadne.
- The active bot does **not** also auto-respond unless the message also mentions that bot or a later product setting asks active actors to comment on all mentions.
- This avoids duplicate/noisy responses while still letting the user deliberately ask multiple actors by mentioning multiple actors.

### 4. Active scratchpad behavior applies in threads

If a thread is created under a scratchpad with an active actor, that actor should be active in the thread too.

Expected behavior:

```text
Chat with <bot name> scratchpad
  └─ Thread under a message
       ├─ User sends a normal message
       └─ The active bot responds in that thread
```

The active actor inherits from the scratchpad root. The reply target is the current thread. This matches the existing Ariadne companion behavior for scratchpad-rooted threads.

## Activation resolution

For each user-authored message, Threa should resolve invocations with a deterministic algorithm:

1. Ignore messages authored by bots/personas/system actors to avoid loops.
2. Resolve explicit `@slug` mentions against available personas and mentionable bots.
3. Resolve the active actor, if any, from the current stream:
   - current stream is a scratchpad with an active actor, or
   - current stream is a thread whose `rootStreamId` points to a scratchpad with an active actor.
4. If the message contains no explicit mentionable-actor mentions, invoke the active actor if one exists.
5. If the message contains explicit mentionable-actor mentions:
   - invoke each mentioned actor once,
   - do not additionally auto-invoke the active actor unless the active actor was explicitly mentioned.
6. Pick the response target:
   - top-level channel mention → create/use a thread on the source message,
   - scratchpad, DM, or existing thread → respond in the current stream,
   - active scratchpad/thread invocation → respond in the current scratchpad/thread.
7. Create provider-neutral invocation records and let runtime adapters claim/process them.

This keeps the common case simple while supporting multi-actor conversations when the user asks for them explicitly.

## Access and safety model

Mentionable and active-scratchpad bots are more powerful than decorative participants because they may read context, call tools, create PRs, and post as themselves. The product model should make access explicit enough to be safe without making normal use tedious.

### Personal bots

- A personal bot is primarily invokable by its owner.
- The owner can mention it from streams where they can write.
- A successful mention or scratchpad attachment should create a scoped bot access relationship for the target stream/root, or an invocation-scoped context snapshot, depending on the runtime surface.
- Long-lived access grants should be visible and revocable. Threa should not silently give a personal bot permanent access to every stream the owner can read.

### Shared bots

- Shared bots are workspace-managed and can be mentionable by members according to workspace policy.
- Admins should control where a shared bot can be active by default.
- Mentioning a shared bot should still respect stream visibility and membership.

### Runtime identity

External runtimes should post back using bot-scoped API keys. Threa should verify that the key belongs to the bot being invoked, not merely to some arbitrary workspace integration.

## Runtime adapter contract

Threa should produce a small, provider-neutral invocation contract. Runtimes implement adapters around it.

```ts
type BotInvocation = {
  id: string
  workspaceId: string
  rootStreamId: string
  activeStreamId: string
  sourceMessageId: string
  responseStreamId: string
  actor: { type: "persona" | "bot"; id: string; slug: string }
  trigger: "active-scratchpad" | "mention"
  requiredCapability: "active-scratchpad" | "mentionable"
  promptMarkdown: string
  authorUserId: string
  mentionedActorSlugs: string[]
  createdAt: string
}
```

`trigger` describes why the invocation exists. `requiredCapability` makes the scheduling requirement explicit: mention invocations require `mentionable`, while ambient scratchpad turns require `active-scratchpad`. A mentionable-only adapter may handle each invocation independently; an active-scratchpad adapter should expect persistent session and concurrency concerns.

Adapter responsibilities:

- discover supported bot/runtime identities,
- claim invocations atomically so multiple local processes do not race,
- map `workspaceId + rootStreamId + activeStreamId + actor.id` to a runtime session,
- fetch/receive the context it is allowed to see,
- run the provider-specific agent loop,
- post progress and final messages back to `responseStreamId`,
- mark the invocation completed/failed/cancelled,
- optionally expose status/artifacts back to Threa.

The claim step is important for local Pi and Claude Code channel-style adapters where multiple local sessions may be open at once.

## Runtime examples

### Custom Pi adapter

A personal Pi bridge can be either mentionable-only or active-scratchpad-capable. The current local bridge prototype behaves like an active local session adapter:

```text
Threa invocation
  → local Pi extension/poller claims it
  → Pi maps stream/thread to a local Pi session
  → Pi injects the prompt into the active session
  → Pi posts the result back as the bot
```

Constraints:

- The local Pi instance must be online.
- A mentionable-only Pi bot could fail fast when offline and avoid dedicated scratchpad/session semantics.
- An active Pi bot needs persistent session binding, in-flight message handling, and visible presence.
- Multiple Pi instances need claim/dedupe or instance targeting.
- Process/worktree policy is local and should not be encoded in Threa.
- This is the fastest iteration path for personal use.

### Hermes

Hermes is best treated as a gateway/runtime adapter. It likely supports both mentionable and active-scratchpad modes:

```text
Threa invocation
  → Hermes Threa platform adapter or Hermes API bridge
  → Hermes gateway session
  → Hermes AIAgent
  → reply back to Threa
```

Constraints:

- Hermes owns sessions, memory, tools, background jobs, and process policy.
- Mentionable Hermes invocations can map to one-off gateway turns.
- Active Hermes scratchpads should map to stable Hermes sessions.
- Threa maps scratchpads/threads to Hermes session keys.
- A native Hermes platform adapter is the long-term fit; an OpenAI-compatible API bridge can be the quick prototype.

### OpenClaw

OpenClaw is best treated as a native channel plugin. Like Hermes, it can support both mentionable and active-scratchpad modes:

```text
Threa invocation
  → OpenClaw Threa channel plugin
  → OpenClaw Gateway
  → selected OpenClaw agentId
  → embedded Pi AgentSession
  → reply back to Threa
```

Constraints:

- OpenClaw owns workspace/session/tool/sandbox policy.
- Mentionable OpenClaw invocations can route to a selected `agentId` for one response.
- Active OpenClaw scratchpads should map to durable channel/session grammar for that `agentId`.
- Threa bot identity can map to OpenClaw `agentId`.
- Threa scratchpad/thread identity maps to OpenClaw channel session grammar.
- Mention gating, sender gating, and reply-thread behavior should live in the OpenClaw channel plugin.

### Claude Code channels

Claude Code channels are a useful protocol precedent for local active-session adapters. They also show why mentionable and active modes should be separate:

```text
Threa event
  → local MCP channel server
  → active Claude Code session receives <channel ...>
  → Claude calls a reply tool
  → MCP channel server posts back to Threa
```

Relevant ideas to borrow:

- capability declaration: the local server advertises that it can receive channel events,
- event notification: external events are injected into an active session as structured channel messages,
- reply tool: the runtime sends outbound messages through a tool exposed by the channel,
- sender gating: inbound messages must be authorized before reaching the agent,
- permission relay: tool approval prompts can be mirrored to the remote chat while the local prompt stays open,
- a channel can be useful for one-shot mention delivery even if it should not become an ambient active scratchpad participant.

Claude channels require an active Claude Code session and are currently research-preview functionality, so they should inform the contract rather than define the Threa product surface.

## Presence and availability

Some mentionable/active actors are always available from Threa's perspective, while others depend on an external runtime being online:

- Ariadne can be treated as available when Threa's own agent workers are healthy.
- Hermes/OpenClaw bots are available when their gateway/adapter is connected.
- Local Pi and Claude Code channel bots are available only while the relevant local session/extension/channel server is running.

Threa should distinguish the existence of a bot from the availability of a runtime that can currently serve it.

### Presence model

Runtime adapters should be able to publish lightweight presence for the bot identities they can serve:

```ts
type BotRuntimePresence = {
  botId: string
  runtimeKind: "pi-local" | "hermes" | "openclaw" | "claude-code-channel" | "custom"
  instanceId: string
  status: "available" | "busy" | "offline" | "error"
  acceptingInvocations: boolean
  lastSeenAt: string
  capabilities?: {
    supportsMentionInvocations?: boolean
    supportsActiveScratchpad?: boolean
    supportsPersistentSessions?: boolean
    supportsStop?: boolean
    supportsPermissionRelay?: boolean
    supportsStreaming?: boolean
  }
  statusText?: string
}
```

Presence should be advisory, not the security boundary. Bot API keys, stream access, and invocation claims remain the source of truth for what a runtime may do.

### Invocation behavior when offline

The simplest product behavior should be:

- If an explicitly mentioned bot has no available runtime, Threa should create a clear failure/notice rather than silently dropping the message.
- If the active actor for a dedicated bot scratchpad is offline, the scratchpad should show an availability indicator and avoid making the user wonder why no reply arrived.
- Threa may keep a short pending/unclaimed window for transient reconnects, but it should eventually mark the invocation as unclaimed/offline.
- Queueing for offline runtimes should be opt-in per adapter. A local Pi or Claude Code session may prefer "fail fast"; a Hermes/OpenClaw gateway may prefer queueing.

### Multiple runtime instances

Presence is also how Threa avoids duplicate local adapters racing:

- More than one runtime instance may advertise that it can serve the same bot.
- Invocation claiming must still be atomic; presence only tells Threa which runtimes appear eligible.
- Runtime instances should have stable `instanceId`s so users can distinguish "Kris's MacBook Pi" from "VPS OpenClaw" if needed.

### UI implications

Presence should surface in a few low-noise places:

- bot mention autocomplete can show available/busy/offline,
- a dedicated bot chat scratchpad can show a small active actor status,
- failed invocations can render as a system notice or bot-status message,
- detailed runtime metadata can remain deferred to the future artifacts/status model.

## Metadata, status, and artifacts

Interactive runtimes will eventually want to expose more than plain chat text:

- usage quotas and model/account status,
- created pull requests,
- hosted implementation plans,
- worktree/branch/session links,
- deployment URLs,
- long-running task progress,
- approval prompts and decisions.

This should be treated as an extension of Threa's reference/context model, not as arbitrary rich blobs in message metadata.

Recommended direction:

1. **V1**: keep runtime output as normal bot messages. Use message metadata only for small bookkeeping such as invocation/run ids, not rich artifacts.
2. **Later**: introduce typed bot artifacts or runtime references that can render as chips/cards and be included in AI context when referenced.
3. **Later**: allow active scratchpads to show a runtime status strip, for example quota remaining or current worktree, without requiring the bot to post noisy status messages.

This parallels the existing `ContextBag` direction: references are typed pointers that can be resolved for display and for AI context, rather than unstructured text copied everywhere.

## Minimal implementation shape

A first implementation should avoid a broad multi-agent orchestration platform. The smallest useful shape is:

1. **Generalize activation semantics**
   - keep one active actor slot for scratchpads,
   - resolve mentions across personas and mentionable bots,
   - inherit the active actor into scratchpad-rooted threads,
   - suppress active auto-response when a different actor is explicitly mentioned.

2. **Create provider-neutral invocations**
   - one invocation per target actor per source message,
   - atomic claim/dedupe,
   - response target chosen by Threa.

3. **Add lightweight runtime presence**
   - adapters heartbeat availability for the bot identities they can serve,
   - UI can show online/busy/offline,
   - invocations fail clearly when no runtime claims them.

4. **Support one external adapter path first**
   - likely the local Pi bridge or OpenClaw channel plugin,
   - use polling if needed,
   - keep the runtime session binding adapter-owned.

5. **Defer artifacts/status**
   - use normal bot messages initially,
   - reserve a clean path for typed runtime references later.

## Open questions

- Should `active-scratchpad` imply `mentionable` at validation time, or should fully interactive bots explicitly carry both traits?
- Should personal bot mention in a shared channel create a persistent bot access grant, or should the first version send an invocation-scoped context snapshot only?
- Should an active actor ever auto-comment on messages that mention a different actor, or is mention-suppression always the right default?
- Should multiple active actors in one scratchpad ever be supported, or should multi-actor conversations stay explicit via mentions?
- What exact UI should show that a scratchpad is a dedicated bot chat and that its active actor is inherited into descendant threads?
- What is the right offline behavior per runtime: fail fast, short pending window, or queue until the runtime reconnects?
- Should runtime presence be per bot, per bot+stream, or per runtime instance with advertised bot ids?
- Should runtime status/artifacts be modeled as a separate table, message attachments, context refs, or a combination?
- What is the minimum realtime surface for adapters: polling public API, Socket.io/SSE, or a dedicated invocation stream?

## Non-goals for this note

- No implementation in this PR.
- No schema or API changes yet.
- No frontend UI changes yet.
- No decision on the local process/worktree model.
- No NemoClaw-specific design; NemoClaw is a sandbox/deployment layer for other runtimes rather than a bot interactivity model.
