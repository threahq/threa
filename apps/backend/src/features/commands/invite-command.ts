import type { Pool } from "pg"
import type { Command, CommandContext, CommandResult } from "./registry"
import { StreamRepository, type Stream, type StreamService } from "../streams"
import { UserRepository } from "../workspaces"
import { BotRepository } from "../public-api"
import { parseMarkdown } from "@threahq/prosemirror"
import {
  actorTypeFromMentionId,
  permissionsForRole,
  StreamTypes,
  WORKSPACE_PERMISSION_SCOPES,
  type JSONContent,
} from "@threahq/types"

interface InviteCommandDeps {
  pool: Pool
  streamService: StreamService
}

type Entity =
  | { type: "user"; id: string; slug: string; name: string }
  | { type: "bot"; id: string; slug: string; name: string }

interface InvitedWire {
  name: string
  slug: string
  type: "user" | "bot"
}

interface InviteResult {
  invited: InvitedWire[]
  unknown?: string[]
  errors?: string[]
}

/**
 * /invite @slug1 @slug2 ... — invite users or bots to a channel or a thread
 * rooted in a channel. Bot invitations require the `bots:manage` permission.
 */
export class InviteCommand implements Command {
  name = "invite"
  description = "Invite users or bots to this channel"

  constructor(private readonly deps: InviteCommandDeps) {}

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const mentions = parseMentionArgs(ctx.args)
    if (mentions.length === 0) {
      return { success: false, error: "Usage: /invite @user1 @user2 ..." }
    }

    const stream = await StreamRepository.findById(this.deps.pool, ctx.streamId)
    if (!stream || stream.workspaceId !== ctx.workspaceId) {
      return { success: false, error: "Stream not found" }
    }
    if (!(await this.isInviteableStream(stream))) {
      return { success: false, error: "/invite is only available in channels and threads whose root is a channel" }
    }

    const userIds: string[] = []
    const botIds: string[] = []
    const slugs: string[] = []
    for (const mention of mentions) {
      const kind = actorTypeFromMentionId(mention.id)
      if (kind === "user") userIds.push(mention.id)
      else if (kind === "bot") botIds.push(mention.id)
      else if (kind === null) slugs.push(mention.slug)
      // persona/broadcast pointers are not invitable; they surface as unknown below
    }

    const [usersById, botsByIdRaw, usersBySlug, botsBySlug, actor] = await Promise.all([
      userIds.length > 0 ? UserRepository.findByIds(this.deps.pool, ctx.workspaceId, userIds) : [],
      botIds.length > 0 ? BotRepository.findByIds(this.deps.pool, ctx.workspaceId, botIds) : [],
      slugs.length > 0 ? UserRepository.findBySlugs(this.deps.pool, ctx.workspaceId, slugs) : [],
      slugs.length > 0 ? BotRepository.findBySlugs(this.deps.pool, ctx.workspaceId, slugs) : [],
      UserRepository.findById(this.deps.pool, ctx.workspaceId, ctx.userId),
    ])
    // findBySlugs excludes archived bots in SQL; findByIds doesn't — filter so a
    // stale pointer to an archived bot lands in `unknown` like an unknown slug.
    const botsById = botsByIdRaw.filter((b) => b.archivedAt === null)

    const canInviteBots =
      actor != null && permissionsForRole(actor.role).includes(WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE)
    if (botsById.length + botsBySlug.length > 0 && !canInviteBots) {
      return { success: false, error: "Insufficient permissions to invite bots" }
    }

    const entityById = new Map<string, Entity>()
    for (const u of [...usersById, ...usersBySlug]) {
      entityById.set(u.id, { type: "user", id: u.id, slug: u.slug, name: u.name })
    }
    for (const b of [...botsById, ...botsBySlug]) {
      entityById.set(b.id, { type: "bot", id: b.id, slug: b.slug ?? b.name, name: b.name })
    }
    const entities = [...entityById.values()]

    // A mention is unknown when neither its id nor its slug matched an
    // invitable entity — covers stale pointer ids, unknown bare slugs, and
    // non-invitable pointer kinds (persona, broadcast) alike.
    const foundSlugs = new Set(entities.map((e) => e.slug.toLowerCase()))
    const unknown = [
      ...new Set(
        mentions
          .filter((m) => !entityById.has(m.id) && !foundSlugs.has(m.slug.toLowerCase()))
          .map((m) => m.slug)
      ),
    ]

    if (entities.length === 0) {
      return { success: false, error: `Unknown users or bots: ${unknown.map((s) => `@${s}`).join(" ")}` }
    }

    const invited: InvitedWire[] = []
    const errors: string[] = []
    for (const entity of entities) {
      try {
        if (entity.type === "user") {
          await this.deps.streamService.addMember(ctx.streamId, entity.id, ctx.workspaceId, ctx.userId)
        } else {
          await this.deps.streamService.addBotToStream(ctx.streamId, entity.id, ctx.workspaceId, ctx.userId)
        }
        invited.push({ name: entity.name, slug: entity.slug, type: entity.type })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to invite"
        errors.push(`@${entity.slug}: ${message}`)
      }
    }

    if (invited.length === 0) {
      return { success: false, error: errors.join("; ") }
    }

    const result: InviteResult = { invited }
    if (unknown.length > 0) result.unknown = unknown.map((s) => `@${s}`)
    if (errors.length > 0) result.errors = errors
    return { success: true, result }
  }

  private async isInviteableStream(stream: Stream): Promise<boolean> {
    if (stream.type === StreamTypes.CHANNEL) return true
    if (stream.type !== StreamTypes.THREAD || !stream.rootStreamId) return false
    const root = await StreamRepository.findById(this.deps.pool, stream.rootStreamId)
    return root?.type === StreamTypes.CHANNEL
  }
}

/**
 * Extract mention targets from the raw command args. The composer dispatches
 * commands as markdown, so a picked mention arrives as a resolved pointer link
 * (`[@test-bot](bot:bot_x)`, INV-64) while a hand-typed one is a bare `@slug`.
 * `parseMarkdown` yields a mention node for both; the id prefix tells them
 * apart (a bare slug's id has no prefix).
 */
function parseMentionArgs(args: string): Array<{ id: string; slug: string }> {
  const mentions: Array<{ id: string; slug: string }> = []
  const walk = (node: JSONContent): void => {
    if (node.type === "mention") {
      const id = node.attrs?.id
      const slug = node.attrs?.slug
      if (typeof id === "string" && typeof slug === "string" && slug) {
        mentions.push({ id, slug })
      }
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(parseMarkdown(args))
  return mentions
}
