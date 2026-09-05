import type { Pool } from "pg"
import type { ModelMessage } from "ai"
import type { AgentTool } from "@threa/agent-runtime"
import type { UserPreferences } from "@threa/types"
import { AgentToolNames, AuthorTypes, StreamTypes } from "@threa/types"
import type { UserPreferencesService } from "../../user-preferences"
import { MessageRepository, SharedMessageRepository, collectSharedMessageIds, type Message } from "../../messaging"
import { UserRepository, type User } from "../../workspaces"
import type { Persona } from "../persona-repository"
import { PersonaAttachmentRepository, type PersonaAttachmentContentItem } from "../persona-attachment-repository"
import { resolveActorNames } from "../actor-names"
import { AttachmentRepository } from "../../attachments"
import {
  StreamRepository,
  StreamBriefRepository,
  resolveBriefStreamId,
  type Stream,
  type StreamBrief,
} from "../../streams"
import { awaitAttachmentProcessing } from "../../attachments"
import { awaitLinkPreviewProcessing } from "../../link-previews"
import { buildStreamContext, type StreamContext } from "../context-builder"
import type { ContextWindowPolicy } from "../context-window-policy"
import type { ConversationSummaryService } from "../conversation-summary-service"
import { buildSystemPrompt, type SplitSystemPrompt } from "./prompt/system-prompt"
import { resolvePersonaStyleSlots } from "./config"
import { loadTurnDigestPromptBlock } from "./turn-digests"
import { loadEpisodeSummaryPromptBlock } from "./episode-summaries"
import { loadConversationHighlight } from "./conversation-highlight"
import { loadCrossSurfaceStitch, formatSpawnedFromContext, type CrossSurfaceStitch } from "./cross-surface-stitch"
import { formatMessagesWithTemporal } from "./prompt/message-format"
import { resolveQuoteReplies, renderMessageWithQuoteContext, DEFAULT_MAX_QUOTE_DEPTH } from "../quote-resolver"
import { computeAgentAccessSpec } from "../researcher/access-spec"
import type { TurnPurpose } from "../turn-purpose"
import { SearchRepository } from "../../search"
import { logger } from "../../../lib/logger"
import { escapeXmlAttr } from "../../../lib/xml"

export interface ContextDeps {
  db: Pool
  userPreferencesService: UserPreferencesService
  conversationSummaryService: ConversationSummaryService
}

export interface ContextParams {
  workspaceId: string
  streamId: string
  stream: Stream
  messageId: string
  persona: Persona
  /** Why this turn is running (roadmap 1.5) — drives mentionerName resolution here. */
  purpose: TurnPurpose
  /**
   * Per-turn hydration policy, resolved at the dispatch (`Hydrate`) seam by
   * `resolveContextWindowPolicy`. Fixes the window budget and whether prior
   * turn digests carry into this turn (DM episode recency, §2.8 Q7/Q8).
   */
  policy: ContextWindowPolicy
  /** Invocation time override for deterministic evals/tests. Production uses Date.now(). */
  currentTime?: Date
  /**
   * Present when this turn is a fired follow-up (roadmap 1.2): the note the
   * follow-up carried and when it was scheduled. Drives the "Scheduled follow-up
   * firing now" prompt section so the turn knows it IS the check-in, not a fresh
   * request to schedule one.
   */
  followUp?: { note: string; scheduledFor: Date }
  /**
   * Present when this turn is a subagent kickoff: the brief the delegating
   * persona wrote. Drives the "You were delegated this" prompt section — the
   * turn's only instruction, since the thread it wakes in is empty.
   */
  subagentBrief?: { title: string }
  /**
   * The human this turn acts for when no trigger message names one — a subagent
   * kickoff wakes in an empty thread, and its authority is the user who was
   * delegated to (INV-50). Without it the turn would run with no invoking user
   * at all: no workspace tools, no access scope, and cost booked to the system
   * rather than the person who asked. The same id is re-checked against
   * `assertStreamWritable` before the turn does any work.
   */
  invokingUserOverride?: string
}

export interface AgentContext {
  /**
   * Compose the final system prompt from the ACTUAL built toolset. Two-phase
   * because the toolset is wired after context build (its deps — workspace
   * access, integrations, researcher callbacks — come from this context), and
   * the prompt's tool sections must reflect exactly what was wired, never a
   * parallel enabled-tools list (INV-44-adjacent: one source of truth).
   *
   * Takes the *effective* purpose at call time — a supersede rerun whose target
   * session vanished, or a follow-up whose row failed to load, is passed as
   * `catch_up` so its prompt section (and derived flags) match the behavior the
   * turn actually takes. The plan/row aren't known until after context build.
   */
  composeSystemPrompt: (tools: AgentTool[], purpose: TurnPurpose) => SplitSystemPrompt
  messages: ModelMessage[]
  triggerMessage: Message | null
  invokingUserId: string | undefined
  /** WorkOS id of the invoking user, for user-layer feature flags. */
  invokingWorkosUserId: string | undefined
  preferences: UserPreferences | undefined
  authorNames: Map<string, string>
  streamContext: StreamContext
  /**
   * Streams the invoking user can read. Used for access-scoped quote-reply
   * resolution and downstream workspace tools. `null` when there is no
   * invoking user (bot-initiated turn) — downstream consumers should treat
   * that as "no workspace access" or "current stream only" per their own
   * semantics.
   */
  accessibleStreamIds: Set<string> | null
  /**
   * The stream's durable brief as read for this turn (roadmap 4.2), off the
   * effective root (threads inherit — INV-62). `null` when none exists yet. The
   * `update_stream_brief` tool writes against its `version` so a concurrent human
   * edit surfaces as a conflict instead of a silent clobber.
   */
  streamBrief: StreamBrief | null
}

async function resolveScratchpadCustomPrompt(
  db: Pool,
  stream: Stream,
  preferences: UserPreferences | undefined
): Promise<string | null> {
  const customPrompt = preferences?.scratchpadCustomPrompt?.trim()
  if (!customPrompt) {
    return null
  }

  if (stream.type === StreamTypes.SCRATCHPAD) {
    return customPrompt
  }

  if (stream.type !== StreamTypes.THREAD || !stream.rootStreamId) {
    return null
  }

  const rootStream = await StreamRepository.findById(db, stream.rootStreamId)
  return rootStream?.type === StreamTypes.SCRATCHPAD ? customPrompt : null
}

/**
 * Assemble all context the companion agent needs before entering the agent loop.
 * Fetches trigger message, builds stream context, resolves author names,
 * creates system prompt, and formats messages as ModelMessage[].
 */
export async function buildAgentContext(deps: ContextDeps, params: ContextParams): Promise<AgentContext> {
  const { db, userPreferencesService, conversationSummaryService } = deps
  const {
    workspaceId,
    streamId,
    stream,
    messageId,
    persona,
    purpose,
    policy,
    currentTime,
    followUp,
    subagentBrief,
    invokingUserOverride,
  } = params

  const triggerMessage = await MessageRepository.findById(db, messageId)
  const invokingUserId =
    triggerMessage?.authorType === AuthorTypes.USER ? triggerMessage.authorId : invokingUserOverride

  let preferences: UserPreferences | undefined
  let invokingUser: User | null = null
  if (invokingUserId) {
    ;[preferences, invokingUser] = await Promise.all([
      userPreferencesService.getPreferences(workspaceId, invokingUserId),
      UserRepository.findById(db, workspaceId, invokingUserId),
    ])
  }

  const linkPreviewProcessing = triggerMessage
    ? awaitLinkPreviewProcessing(db, workspaceId, [triggerMessage])
    : Promise.resolve()

  // Await attachment processing for trigger message so agent can access extracted content
  if (triggerMessage) {
    const triggerAttachments = await AttachmentRepository.findByMessageId(db, messageId)
    const attachmentIds = triggerAttachments.map((a) => a.id)
    if (attachmentIds.length > 0) {
      logger.info(
        { messageId, attachmentCount: attachmentIds.length },
        "Awaiting attachment processing for trigger message"
      )
      const awaitResult = await awaitAttachmentProcessing(db, attachmentIds)
      logger.info(
        {
          messageId,
          completedCount: awaitResult.completedIds.length,
          failedCount: awaitResult.failedOrTimedOutIds.length,
        },
        "Attachment processing await completed"
      )
    }
  }

  // Link-preview extraction is an independent outbox peer, so its junction row
  // may not exist yet when the companion job starts. Bound the wait; timeout
  // still gives the agent the original URL and any previews that did finish.
  await linkPreviewProcessing

  // Compute accessible streams once, here — used by both quote-reply resolution
  // below and by the workspace-tool deps wiring in persona-agent.ts. Bot turns
  // (no invoking user) get `null`; downstream consumers decide how to treat it.
  let accessibleStreamIds: Set<string> | null = null
  if (invokingUserId) {
    const accessSpec = await computeAgentAccessSpec(db, { stream, invokingUserId })
    const ids = await SearchRepository.getAccessibleStreamsForAgent(db, accessSpec, workspaceId)
    accessibleStreamIds = new Set(ids)
  }

  const streamContext = await buildStreamContext(db, stream, {
    preferences,
    // users.timezone is the heartbeat-fresh device timezone; it wins over the
    // "home timezone" preference so scheduling and "now" match the device.
    deviceTimezone: invokingUser?.timezone ?? undefined,
    currentTime,
    maxMessages: policy.maxMessages,
    maxChars: policy.maxChars,
    triggerMessageId: messageId,
    includeAttachments: true,
    includeLinkPreviews: true,
  })

  const streamScopedMessages = streamContext.conversationHistory.filter((m) => m.streamId === stream.id)
  const rollingConversationSummary = await conversationSummaryService.updateForContext({
    db,
    workspaceId,
    streamId: stream.id,
    personaId: persona.id,
    keptMessages: streamScopedMessages,
  })

  // "Previous sessions" — the persona's own recent completed-session episode
  // summaries in this stream (roadmap 3.1). Distinct from the rolling summary
  // (which folds dropped *messages*): this carries what earlier sessions *did and
  // concluded*, so "as we discussed last week" survives the window scrolling
  // past. Single pooled read (INV-30); the in-flight session has no summary yet
  // so it's excluded by construction.
  const previousSessionsBlock = await loadEpisodeSummaryPromptBlock(db, {
    streamId: stream.id,
    personaId: persona.id,
  })

  // Durable stream brief (roadmap 4.1): the stream's standing working document,
  // injected into every turn. Threads inherit the root stream's brief — the
  // brief keys on the effective root, same rule as access (INV-62).
  const streamBrief = await StreamBriefRepository.findByStreamId(db, workspaceId, resolveBriefStreamId(stream))

  // Persona standing knowledge (context attachments): the persona's uploaded
  // files, joined to their extraction content in one pooled read (INV-56, no
  // client held across the AI work below — INV-41). Only custom/personal
  // personas own attachment rows; a built-in (`managed_by: system`) has no owned
  // row to bind to, so it skips the query entirely (zero attachment reads). A
  // draft-test turn resolves the SAVED persona's `id` here (drafts share it), so
  // the block reflects the saved attachments without any special-casing.
  const personaKnowledge: PersonaAttachmentContentItem[] =
    persona.managedBy === "system"
      ? []
      : await PersonaAttachmentRepository.listForPersonaWithContent(db, workspaceId, persona.id)

  // Best-effort "Current Topic" highlight (§2.8 Q8): the topic the segmenter has
  // placed this turn in, surfaced over the contiguous window. Reads current
  // classification only — never awaits extraction — so it degrades to no
  // highlight when the segmenter is behind, and is plaintext-only by
  // construction (the segmenter short-circuits E2E streams).
  const conversationTopic = await loadConversationHighlight(db, {
    workspaceId,
    triggerMessageId: messageId,
    windowMessageIds: streamScopedMessages.map((m) => m.id),
  })

  // Cross-surface continuity (§2.8 Q8 follow-up): when this thread was spawned
  // from a channel discussion, stitch that discussion's own messages in as
  // background so a persona pulled from a channel into a thread keeps what it
  // was pulled from. Best-effort and never-awaited, same discipline as the
  // highlight. Priority fill: the thread's own window takes the char budget
  // first, the stitch gets only what remains — generous on a fresh thread (when
  // continuity matters most) and gone once the thread carries its own depth.
  // Measured before quote/shared-message enrichment so the budget tracks raw
  // window markdown, the same basis the C-2b fetch trim uses.
  let crossSurfaceStitch: CrossSurfaceStitch | null = null
  if (stream.type === StreamTypes.THREAD) {
    const windowChars = streamContext.conversationHistory.reduce((sum, m) => sum + m.contentMarkdown.length, 0)
    crossSurfaceStitch = await loadCrossSurfaceStitch(db, {
      workspaceId,
      thread: stream,
      maxChars: policy.maxChars - windowChars,
    })
  }

  // Build author names from participants + a single batched user+persona lookup.
  // `resolveActorNames` handles the user/persona split (INV-56: batched, never
  // per-row) so we don't reimplement it inline per surface.
  const authorNames = new Map<string, string>()
  if (streamContext.participants) {
    for (const p of streamContext.participants) {
      authorNames.set(p.id, p.name)
    }
  }

  // Collect both message authors and reaction actors that we don't yet have a
  // name for. Reactors can be users or personas (the agent reacting to a
  // message) and need not be participants, so they often won't be covered by
  // the participants pass above — resolve them so the reactions annotation in
  // the formatted prompt names who reacted instead of "someone".
  const unresolvedIds = new Set<string>()
  for (const m of streamContext.conversationHistory) {
    if (!authorNames.has(m.authorId)) unresolvedIds.add(m.authorId)
    for (const reactorIds of Object.values(m.reactions)) {
      for (const reactorId of reactorIds) {
        if (!authorNames.has(reactorId)) unresolvedIds.add(reactorId)
      }
    }
  }
  // Stitched channel-discussion authors are usually not thread participants, so
  // resolve them in the same batch (INV-56) — the block names them, not "Unknown".
  if (crossSurfaceStitch) {
    for (const m of crossSurfaceStitch.messages) {
      if (!authorNames.has(m.authorId)) unresolvedIds.add(m.authorId)
    }
  }
  const resolvedNames = await resolveActorNames(db, workspaceId, [...unresolvedIds])
  for (const [id, name] of resolvedNames) authorNames.set(id, name)

  let mentionerName: string | undefined
  if (purpose.kind === "mention" && triggerMessage?.authorType === AuthorTypes.USER) {
    // invokingUser IS the trigger author when authorType is USER (see above).
    mentionerName = invokingUser?.name ?? undefined
  }

  // Resolve quote-reply precursors referenced from the conversation history and
  // expand each message's contentMarkdown inline with `<quoted-source>` blocks
  // so the model sees the full source of anything that was quoted, not just
  // the snippet. Bot turns fall back to "current stream only" to avoid leaking
  // cross-stream content when there is no invoking user to gate access.
  const quoteAccessibleStreamIds = accessibleStreamIds ?? new Set([stream.id])
  const {
    resolved: resolvedQuotes,
    authorNames: quotedAuthorNames,
    pinnedVersions: pinnedQuoteVersions,
  } = await resolveQuoteReplies(db, workspaceId, {
    seedMessages: streamContext.conversationHistory,
    accessibleStreamIds: quoteAccessibleStreamIds,
  })
  for (const [id, name] of quotedAuthorNames) {
    if (!authorNames.has(id)) authorNames.set(id, name)
  }
  if (resolvedQuotes.size > 0) {
    streamContext.conversationHistory = streamContext.conversationHistory.map((m) => {
      const expanded = renderMessageWithQuoteContext(
        m,
        resolvedQuotes,
        authorNames,
        0,
        DEFAULT_MAX_QUOTE_DEPTH,
        pinnedQuoteVersions
      )
      if (expanded === m.contentMarkdown) return m
      return { ...m, contentMarkdown: expanded }
    })
  }

  // Inline cross-stream shared-message sources for the agent. The wire-format
  // markdown for a `sharedMessage` node is just an opaque `shared-message:`
  // link, so without this expansion the model only sees "Shared a message
  // from X" and never the actual content. Append a `<shared-message-source>`
  // block per resolved source so the body, author, and origin are dead-clear.
  //
  // Access rule (D6): include a source if its own stream is reachable to the
  // viewer OR any of its share-grant `target_stream_id`s is reachable. Bot
  // turns fall back to "current stream only" so cross-stream sources only
  // surface via an explicit share grant into this stream.
  const sharedAccessibleStreamIds = accessibleStreamIds ?? new Set([stream.id])
  const seedMessageIds = new Set(streamContext.conversationHistory.map((m) => m.id))
  const sharedRefIds = new Set<string>()
  const collected = new Set<string>()
  for (const m of streamContext.conversationHistory) {
    collectSharedMessageIds(m.contentJson, collected)
  }
  for (const id of collected) {
    if (!seedMessageIds.has(id)) sharedRefIds.add(id)
  }

  if (sharedRefIds.size > 0) {
    const refIdArray = [...sharedRefIds]
    const [sourceCandidates, grants] = await Promise.all([
      MessageRepository.findByIdsInWorkspace(db, workspaceId, refIdArray),
      SharedMessageRepository.listBySourceMessageIds(db, workspaceId, refIdArray),
    ])

    // sourceMessageId -> targets it has been shared into
    const grantTargetsBySource = new Map<string, Set<string>>()
    for (const g of grants) {
      let set = grantTargetsBySource.get(g.sourceMessageId)
      if (!set) {
        set = new Set()
        grantTargetsBySource.set(g.sourceMessageId, set)
      }
      set.add(g.targetStreamId)
    }

    const allowedSources = new Map<string, Message>()
    for (const id of refIdArray) {
      const source = sourceCandidates.get(id)
      if (!source || source.deletedAt) continue
      const sourceVisibleByMembership = sharedAccessibleStreamIds.has(source.streamId)
      const grantTargets = grantTargetsBySource.get(id)
      const sourceVisibleByGrant = !!grantTargets && [...grantTargets].some((t) => sharedAccessibleStreamIds.has(t))
      if (sourceVisibleByMembership || sourceVisibleByGrant) {
        allowedSources.set(id, source)
      } else {
        logger.debug(
          { sharedSourceId: id, reason: "not_accessible" },
          "Shared-message source skipped during agent context build"
        )
      }
    }

    // Resolve any author names we don't already have for the new sources.
    // `resolveActorNames` handles the user/persona split internally, so the
    // share-source enrichment uses the same batched helper as the main
    // history pass — no parallel implementation per surface.
    const missingSourceAuthorIds = [
      ...new Set([...allowedSources.values()].filter((m) => !authorNames.has(m.authorId)).map((m) => m.authorId)),
    ]
    const sourceAuthorNames = await resolveActorNames(db, workspaceId, missingSourceAuthorIds)
    for (const [id, name] of sourceAuthorNames) authorNames.set(id, name)

    streamContext.conversationHistory = streamContext.conversationHistory.map((m) => {
      const ids = new Set<string>()
      collectSharedMessageIds(m.contentJson, ids)
      if (ids.size === 0) return m
      const blocks: string[] = []
      for (const id of ids) {
        const source = allowedSources.get(id)
        if (!source) continue
        const author = authorNames.get(source.authorId) ?? "Unknown"
        blocks.push(
          `<shared-message-source sourceMessageId="${escapeXmlAttr(source.id)}" author="${escapeXmlAttr(author)}" sourceStreamId="${escapeXmlAttr(source.streamId)}" createdAt="${source.createdAt.toISOString()}">\n${source.contentMarkdown}\n</shared-message-source>`
        )
      }
      if (blocks.length === 0) return m
      return { ...m, contentMarkdown: [m.contentMarkdown, ...blocks].join("\n\n") }
    })
  }

  const scratchpadCustomPrompt = await resolveScratchpadCustomPrompt(db, stream, preferences)

  // Prior turns' tool-work digests (C-1), re-filtered against the location's
  // CURRENT access set — see buildTurnDigestPromptBlock for the scope-drift
  // rule. Appended after the base prompt so both first-party drivers fold the
  // identically-formatted block in at the same point (the enclave appends the
  // same formatter's output in run-turn).
  //
  // Gated on the episode boundary (§2.5 / §2.8 Q8): a DM turn that opens a
  // fresh episode — the prior session's cursor fell outside this window — must
  // not carry that episode's digest chain. Bounded surfaces always carry
  // (`policy.carryDigests` is true for them).
  const turnDigestBlock = policy.carryDigests
    ? await loadTurnDigestPromptBlock(db, {
        streamId: stream.id,
        personaId: persona.id,
        accessibleStreamIds,
      })
    : null

  // Render the stitched discussion once author names are fully resolved. Null
  // when there's nothing to stitch (no spawning conversation, or a deep thread
  // whose window left no budget).
  const spawnedFromContext =
    crossSurfaceStitch && crossSurfaceStitch.messages.length > 0
      ? formatSpawnedFromContext(crossSurfaceStitch, authorNames, streamContext.temporal)
      : null

  const composeSystemPrompt = (tools: AgentTool[], effectivePurpose: TurnPurpose): SplitSystemPrompt => {
    const systemPrompt = buildSystemPrompt({
      persona,
      context: streamContext,
      scratchpadCustomPrompt,
      purpose: effectivePurpose,
      mentionerName,
      rollingConversationSummary,
      tools,
      conversationTopic,
      spawnedFromContext,
      followUp,
      subagentBrief,
      previousSessions: previousSessionsBlock,
      // Only when the tool that can act on them is actually in this turn's
      // toolset. Elsewhere these values are tokens the model can neither use
      // nor was asked about — and `composeSystemPrompt` receives the built
      // tools, so this cannot drift from availability.
      currentSettings: tools.some((tool) => tool.name === AgentToolNames.UPDATE_USER_SETTINGS)
        ? (preferences ?? null)
        : null,
      streamBrief: streamBrief?.content ?? null,
      styleSlots: resolvePersonaStyleSlots(persona),
      personaKnowledge,
    })
    // Prior-turn digests are re-derived each turn, so they belong outside the
    // cached span alongside temporal grounding.
    return turnDigestBlock
      ? { ...systemPrompt, volatile: `${systemPrompt.volatile}\n\n${turnDigestBlock}` }
      : systemPrompt
  }

  const messages = formatMessagesWithTemporal(streamContext.conversationHistory, streamContext, authorNames)

  return {
    composeSystemPrompt,
    messages,
    triggerMessage,
    invokingUserId,
    invokingWorkosUserId: invokingUser?.workosUserId,
    preferences,
    authorNames,
    streamContext,
    accessibleStreamIds,
    streamBrief,
  }
}
