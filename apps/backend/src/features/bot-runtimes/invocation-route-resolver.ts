import { resolveDeliveryVerdict, TrustTiers } from "@threa/agent-runtime"
import { collectMentionActorRefs, collectMentionSlugs } from "@threa/prosemirror"
import {
  AuthorTypes,
  StreamTypes,
  botHasCapability,
  type BotInvocationCapability,
  type BotInvocationTrigger,
} from "@threa/types"
import type { Querier } from "../../db"
import { logger } from "../../lib/logger"
import { resolveSealingContext } from "../e2e-streams"
import { MessageVersionRepository, type InvocationSourceState } from "../messaging"
import { BotRepository } from "../public-api"
import { projectStreamForBot, StreamRepository, type Stream } from "../streams"
import {
  BotInvocationRepository,
  BotRuntimeInstanceRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
} from "./repository"
import { resolveRuntimeKindConfig } from "./runtime-kind-config"

export interface CanonicalInvocationRoute {
  actorId: string
  trigger: BotInvocationTrigger
  requiredCapability: BotInvocationCapability
  rootStreamId: string
  activeStreamId: string
  responseStreamId: string
  authorUserId: string
  mentionedActorSlugs: string[]
  targetInstanceId: string | null
  targetRuntimeSessionId: string | null
  promptMarkdown: string
  missingLinkNotice: string | null
}

export function buildCanonicalInvocationPrompt(source: InvocationSourceState): string {
  if (source.authorType === AuthorTypes.USER) return source.contentMarkdown
  return [
    "A non-user message was posted in your active Threa scratchpad.",
    "Use the stream context to decide whether a reply is useful. If no reply is needed, respond exactly: THREA_NO_RESPONSE",
    "",
    source.contentMarkdown,
  ].join("\n")
}

export interface EditedSourceContext {
  previousMarkdown: string
  previousRevision: number
  currentRevision: number
}

/**
 * Frames a source edit that landed after the actor already completed a turn on
 * it. The invocation is a fresh turn, so the runtime session still carries the
 * previous answer — this only supplies what the edit changed and leaves the
 * decision to the agent.
 */
export function buildEditedSourcePrompt(prompt: string, edit: EditedSourceContext): string {
  const previous = edit.previousMarkdown
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
  return [
    prompt,
    "",
    "---",
    "",
    `You already answered this message. It was edited afterwards (revision ${edit.previousRevision} to ${edit.currentRevision}). What it said when you answered:`,
    "",
    previous,
    "",
    "The wording above the separator is current and is what the author now means; the quoted wording is obsolete.",
    "Work out what the edit changes. If your previous answer no longer holds, answer the edited request directly. If it still holds, say so in a line instead of repeating it. Do not narrate the edit itself.",
  ].join("\n")
}

async function allows(db: Querier, source: InvocationSourceState, stream: Stream, botId: string): Promise<boolean> {
  const viewer = await projectStreamForBot(db, { workspaceId: source.workspaceId, stream, botId })
  if (!viewer || viewer.readOnly) {
    logger.info(
      { workspaceId: source.workspaceId, streamId: source.streamId, botId, reason: viewer?.readOnlyReason ?? null },
      "Skipping bot invocation because the bot cannot write to the stream"
    )
    return false
  }
  const sealing = await resolveSealingContext(db, {
    workspaceId: source.workspaceId,
    streamId: source.streamId,
    actor: { kind: "bot", botId },
  })
  const verdict = resolveDeliveryVerdict({ trust: TrustTiers.THIRD_PARTY, sealing })
  if (verdict.delivery === "plaintext" || verdict.delivery === "sealed") return true
  logger.info(
    { workspaceId: source.workspaceId, streamId: source.streamId, botId, verdict },
    "Skipping bot invocation because the external wire cannot carry the delivery verdict"
  )
  return false
}

/**
 * Prompt framing lives here rather than at the reconcile call site because the
 * claim path re-resolves routes and overwrites `prompt_markdown` with what this
 * returns — anything added downstream of it is discarded before the runtime
 * reads the turn.
 */
export async function resolveCanonicalInvocationRoutes(
  db: Querier,
  source: InvocationSourceState
): Promise<CanonicalInvocationRoute[]> {
  return applyEditedSourceFraming(db, source, await resolveRoutes(db, source))
}

/**
 * Per-actor framing for an edit that landed after that actor already completed
 * a turn on this source. `message_versions` holds the text of each superseded
 * revision, so the completed turn's revision resolves to exactly what that
 * actor was answering.
 */
async function applyEditedSourceFraming(
  db: Querier,
  source: InvocationSourceState,
  routes: CanonicalInvocationRoute[]
): Promise<CanonicalInvocationRoute[]> {
  if (source.revision <= 1 || routes.length === 0) return routes
  const answered = await BotInvocationRepository.listCompletedTurnRevisionsBySource(db, {
    workspaceId: source.workspaceId,
    sourceMessageId: source.messageId,
    actorIds: routes.map((route) => route.actorId),
  })
  const staleRevisions = [...new Set([...answered.values()].filter((revision) => revision < source.revision))]
  if (staleRevisions.length === 0) return routes
  const versions = await MessageVersionRepository.findByVersionNumbers(db, source.messageId, staleRevisions)
  const markdownByRevision = new Map(versions.map((version) => [version.versionNumber, version.contentMarkdown]))
  return routes.map((route) => {
    const previousRevision = answered.get(route.actorId)
    if (previousRevision === undefined || previousRevision >= source.revision) return route
    const previousMarkdown = markdownByRevision.get(previousRevision)
    if (previousMarkdown === undefined) {
      logger.info(
        {
          workspaceId: source.workspaceId,
          sourceMessageId: source.messageId,
          actorId: route.actorId,
          previousRevision,
        },
        "Rerunning an edited source without the answered wording: no message version row for that revision"
      )
      return route
    }
    if (previousMarkdown === source.contentMarkdown) return route
    return {
      ...route,
      promptMarkdown: buildEditedSourcePrompt(route.promptMarkdown, {
        previousMarkdown,
        previousRevision,
        currentRevision: source.revision,
      }),
    }
  })
}

async function resolveRoutes(db: Querier, source: InvocationSourceState): Promise<CanonicalInvocationRoute[]> {
  if (source.deleted || source.authorType === AuthorTypes.SYSTEM) return []
  const stream = await StreamRepository.findByIdForWorkspace(db, source.streamId, source.workspaceId)
  if (!stream || stream.workspaceId !== source.workspaceId || stream.archivedAt) return []
  const rootId = stream.rootStreamId ?? stream.id
  const root =
    rootId === stream.id ? stream : await StreamRepository.findByIdForWorkspace(db, rootId, source.workspaceId)
  const userAuthored = source.authorType === AuthorTypes.USER
  const refs = userAuthored ? collectMentionActorRefs(source.contentJson) : []
  const mentionedBotIds = refs.filter((ref) => ref.actorType === "bot").map((ref) => ref.actorId)
  const hasPersona = refs.some((ref) => ref.actorType === "persona")
  const mentioned = mentionedBotIds.length
    ? await BotRepository.findInvocableByIds(db, source.workspaceId, source.authorId, mentionedBotIds)
    : []
  const mentionable = mentioned.filter((bot) => botHasCapability(bot, "mentionable"))
  const slugs = userAuthored ? collectMentionSlugs(source.contentJson) : []
  const routes: CanonicalInvocationRoute[] = []
  for (const bot of mentionable) {
    if (!(await allows(db, source, stream, bot.id))) continue
    routes.push({
      actorId: bot.id,
      trigger: "mention",
      requiredCapability: "mentionable",
      rootStreamId: root?.id ?? stream.id,
      activeStreamId: stream.id,
      responseStreamId: stream.id,
      authorUserId: source.authorId,
      mentionedActorSlugs: slugs,
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      promptMarkdown: buildCanonicalInvocationPrompt(source),
      missingLinkNotice: null,
    })
  }
  if (!root || root.type !== StreamTypes.SCRATCHPAD || root.archivedAt) return routes
  const active = await StreamActiveActorRepository.findByRootStream(db, source.workspaceId, root.id)
  if (!active || active.actorType !== "bot") return routes
  const bot = await BotRepository.findById(db, source.workspaceId, active.actorId)
  if (!bot || bot.archivedAt || !botHasCapability(bot, "active-scratchpad")) return routes
  if (source.authorType === AuthorTypes.BOT && source.authorId === bot.id) return routes
  if (mentionable.some((candidate) => candidate.id === bot.id)) return routes
  if ((mentionable.length > 0 || hasPersona) && !mentionedBotIds.includes(bot.id)) return routes
  if (!(await allows(db, source, stream, bot.id))) return routes
  let link = await BotRuntimeSessionLinkRepository.findActiveByStream(db, {
    workspaceId: source.workspaceId,
    botId: bot.id,
    rootStreamId: root.id,
    activeStreamId: stream.id,
  })
  if (!link && stream.id !== root.id) {
    link = await BotRuntimeSessionLinkRepository.findActiveByStream(db, {
      workspaceId: source.workspaceId,
      botId: bot.id,
      rootStreamId: root.id,
      activeStreamId: root.id,
    })
  }
  let missingLinkNotice: string | null = null
  if (!link) {
    const instances = await BotRuntimeInstanceRepository.findLatestForBots(db, source.workspaceId, [bot.id])
    const config = resolveRuntimeKindConfig(instances.get(bot.id)?.runtimeKind ?? null)
    if (config.sessionLinking === "required") missingLinkNotice = config.missingSessionLinkNotice(bot.name)
  }
  const activeScratchpadRoute = {
    actorId: bot.id,
    trigger: "active-scratchpad" as const,
    requiredCapability: "active-scratchpad" as const,
    rootStreamId: root.id,
    activeStreamId: stream.id,
    responseStreamId: stream.id,
    authorUserId: source.authorId,
    mentionedActorSlugs: slugs,
    promptMarkdown: buildCanonicalInvocationPrompt(source),
  }
  if (missingLinkNotice) {
    return [
      ...routes,
      {
        ...activeScratchpadRoute,
        targetInstanceId: null,
        targetRuntimeSessionId: null,
        missingLinkNotice,
      },
    ]
  }
  routes.push({
    ...activeScratchpadRoute,
    targetInstanceId: link?.instanceId ?? null,
    targetRuntimeSessionId: link?.runtimeSessionId ?? null,
    missingLinkNotice: null,
  })
  return routes
}
