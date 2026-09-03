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
import type { InvocationSourceState } from "../messaging"
import { BotRepository } from "../public-api"
import { projectStreamForBot, StreamRepository, type Stream } from "../streams"
import {
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

export async function resolveCanonicalInvocationRoutes(
  db: Querier,
  source: InvocationSourceState
): Promise<CanonicalInvocationRoute[]> {
  if (source.deleted || source.authorType === AuthorTypes.SYSTEM) return []
  const stream = await StreamRepository.findById(db, source.streamId)
  if (!stream || stream.workspaceId !== source.workspaceId || stream.archivedAt) return []
  const rootId = stream.rootStreamId ?? stream.id
  const root = rootId === stream.id ? stream : await StreamRepository.findById(db, rootId)
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
