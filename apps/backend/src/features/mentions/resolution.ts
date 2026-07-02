import {
  type JSONContent,
  type MentionActorType,
  MENTION_BROADCAST_HERE,
  MENTION_BROADCAST_CHANNEL,
} from "@threa/types"
import {
  collectUnresolvedChannelLinkSlugs,
  collectUnresolvedMentionSlugs,
  mapMentionAndChannelNodes,
} from "@threa/prosemirror"
import type { Querier } from "../../db"
import { UserRepository } from "../workspaces"
import { PersonaRepository } from "../agents"
// Direct module import (not the barrel) to avoid a cycle: the public-api barrel
// pulls in handlers → messaging → this resolver.
import { BotRepository } from "../public-api/bot-repository"
import { StreamRepository } from "../streams"

/**
 * Mention/channel-link ids are the authoritative actor/stream reference in
 * stored `contentJson` (INV-64). The markdown ingestion path writes a bare slug
 * as the id (`parseMarkdown`); this resolver rewrites those to real ids at write
 * time so downstream logic never re-resolves by slug. `slug` stays as a display
 * label, so markdown serialization (`@slug`/`#slug`) is unaffected.
 */

export interface MentionResolutionMaps {
  /** Lowercased slug → resolved mention actor id + kind. */
  mentionSlugToActor: Map<string, { id: string; actorType: MentionActorType }>
  /** Lowercased slug → resolved stream id. */
  channelSlugToStreamId: Map<string, string>
}

/**
 * Pure: rewrite unresolved mention/channelLink ids using prebuilt maps. Shared
 * by ingestion and backfill (DRY). Also normalizes broadcast slugs
 * (`here`/`channel`) to their sentinel id + `mentionType: "broadcast"`, and sets
 * the correct `mentionType` for resolved mentions. Returns the (possibly new)
 * tree and whether anything changed.
 */
export function applyMentionResolution(
  contentJson: JSONContent,
  maps: MentionResolutionMaps
): { contentJson: JSONContent; changed: boolean } {
  let changed = false

  const next = mapMentionAndChannelNodes(contentJson, (node) => {
    const attrs = node.attrs
    if (!attrs) return undefined
    const id = attrs.id
    const slug = attrs.slug
    if (typeof id !== "string" || typeof slug !== "string") return undefined
    const lower = slug.toLowerCase()

    if (node.type === "mention") {
      if (lower === "here") {
        if (id === MENTION_BROADCAST_HERE && attrs.mentionType === "broadcast") return undefined
        changed = true
        return { ...attrs, id: MENTION_BROADCAST_HERE, mentionType: "broadcast" }
      }
      if (lower === "channel") {
        if (id === MENTION_BROADCAST_CHANNEL && attrs.mentionType === "broadcast") return undefined
        changed = true
        return { ...attrs, id: MENTION_BROADCAST_CHANNEL, mentionType: "broadcast" }
      }
      const actor = maps.mentionSlugToActor.get(lower)
      if (!actor) return undefined
      if (id === actor.id && attrs.mentionType === actor.actorType) return undefined
      changed = true
      return { ...attrs, id: actor.id, mentionType: actor.actorType }
    }

    // channelLink
    const streamId = maps.channelSlugToStreamId.get(lower)
    if (!streamId || id === streamId) return undefined
    changed = true
    return { ...attrs, id: streamId }
  })

  return { contentJson: changed ? next : contentJson, changed }
}

/**
 * Batched DB lookups (INV-56) with precedence user › persona › bot for mention
 * slugs; streams for channel slugs. First match in that order wins for an
 * ambiguous slug. Broadcast slugs are not looked up here (the pure step handles
 * their sentinels).
 */
export async function buildMentionResolutionMaps(
  querier: Querier,
  workspaceId: string,
  input: { mentionSlugs: string[]; channelSlugs: string[] }
): Promise<MentionResolutionMaps> {
  const mentionSlugToActor = new Map<string, { id: string; actorType: MentionActorType }>()
  const channelSlugToStreamId = new Map<string, string>()

  const pending = new Set(input.mentionSlugs.map((slug) => slug.toLowerCase()))

  if (pending.size > 0) {
    const users = await UserRepository.findBySlugs(querier, workspaceId, [...pending])
    for (const user of users) {
      const key = user.slug.toLowerCase()
      if (pending.has(key)) {
        mentionSlugToActor.set(key, { id: user.id, actorType: "user" })
        pending.delete(key)
      }
    }
  }

  if (pending.size > 0) {
    const personas = await PersonaRepository.findBySlugs(querier, [...pending], workspaceId)
    for (const persona of personas) {
      const key = persona.slug.toLowerCase()
      if (pending.has(key)) {
        mentionSlugToActor.set(key, { id: persona.id, actorType: "persona" })
        pending.delete(key)
      }
    }
  }

  if (pending.size > 0) {
    const bots = await BotRepository.findBySlugs(querier, workspaceId, [...pending])
    for (const bot of bots) {
      if (!bot.slug) continue
      const key = bot.slug.toLowerCase()
      if (pending.has(key)) {
        mentionSlugToActor.set(key, { id: bot.id, actorType: "bot" })
        pending.delete(key)
      }
    }
  }

  if (input.channelSlugs.length > 0) {
    const streams = await StreamRepository.findBySlugs(querier, workspaceId, input.channelSlugs)
    for (const stream of streams) {
      if (stream.slug) {
        channelSlugToStreamId.set(stream.slug.toLowerCase(), stream.id)
      }
    }
  }

  return { mentionSlugToActor, channelSlugToStreamId }
}

/**
 * Ingestion entry point (INV-64): resolve unresolved mention/channel ids in
 * `contentJson` to authoritative actor/stream ids. Idempotent and cheap — a
 * no-op (`changed: false`) when nothing is unresolved, so it is safe to run on
 * every write including E2E placeholder content (which carries no mentions).
 */
export async function resolveMentionContent(
  querier: Querier,
  workspaceId: string,
  contentJson: JSONContent
): Promise<{ contentJson: JSONContent; changed: boolean }> {
  const mentionSlugs = collectUnresolvedMentionSlugs(contentJson)
  const channelSlugs = collectUnresolvedChannelLinkSlugs(contentJson)
  // Broadcast nodes (`@here`/`@channel`) carry a bare slug from the markdown
  // path but are excluded from the slug collectors (no DB lookup); they still
  // need normalizing to the sentinel id, so check for them explicitly.
  if (mentionSlugs.length === 0 && channelSlugs.length === 0 && !hasUnnormalizedBroadcast(contentJson)) {
    return { contentJson, changed: false }
  }

  const maps = await buildMentionResolutionMaps(querier, workspaceId, { mentionSlugs, channelSlugs })
  return applyMentionResolution(contentJson, maps)
}

function hasUnnormalizedBroadcast(contentJson: JSONContent): boolean {
  let found = false
  const walk = (node: JSONContent): void => {
    if (found) return
    if (node.type === "mention") {
      const slug = node.attrs?.slug
      const id = node.attrs?.id
      if (typeof slug === "string") {
        const lower = slug.toLowerCase()
        if (
          (lower === "here" && id !== MENTION_BROADCAST_HERE) ||
          (lower === "channel" && id !== MENTION_BROADCAST_CHANNEL)
        ) {
          found = true
          return
        }
      }
    }
    if (node.content) {
      for (const child of node.content) walk(child)
    }
  }
  walk(contentJson)
  return found
}
