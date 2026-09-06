import {
  getAvatarUrl,
  getBotAvatarUrl,
  getPersonaAvatarUrl,
  resolveActiveStatus,
  resolveNotificationPause,
  type ActiveNotificationPause,
  type AuthorType,
  type Bot,
  type EmojiEntry,
  type Persona,
  type User,
} from "@threahq/types"
// Namespace imports so a test can spy the shared builders against the module (INV-48).
import * as emojiPicker from "@/lib/emoji-picker"
import * as perfCapture from "@/lib/perf/capture"

/** Resolved, expiry-masked status for an actor (users only today). */
export interface ActorStatus {
  /** Emoji glyph for the avatar badge, or null when the status has only text. */
  emoji: string | null
  text: string | null
  /** ISO instant the status auto-clears at, or null for indefinite. */
  expiresAt: string | null
}

interface ActorAvatarInfo {
  fallback: string
  slug?: string
  avatarUrl?: string
  /** Present only when the actor is a user with an active status. */
  status?: ActorStatus
  /**
   * The user's active notification pause (do-not-disturb), when present —
   * carries the end instant so callers can show "paused until …".
   */
  dnd?: ActiveNotificationPause
}

export interface ActorLookup {
  getActorName: (actorId: string | null, actorType: AuthorType | null) => string
  getActorInitials: (actorId: string | null, actorType: AuthorType | null) => string
  /** Returns avatar info including fallback text and persona slug (for SVG icon support) */
  getActorAvatar: (actorId: string | null, actorType: AuthorType | null) => ActorAvatarInfo
  getUser: (userId: string) => User | undefined
  getPersona: (personaId: string) => Persona | undefined
  getBot: (botId: string) => Bot | undefined
}

export interface WorkspaceEmojiIndexes {
  workspaceId: string | null
  emojis: EmojiEntry[]
  emojiWeights: Record<string, number>
  toEmoji: (shortcode: string) => string | null
  getEmoji: (shortcode: string) => EmojiEntry | undefined
  toShortcode: (emoji: string) => string | null
}

/**
 * Infer an actor's type from its prefixed ULID. Used where only the id is
 * known — notably reactions, which store `Record<emoji, actorId[]>` with no
 * per-reactor type. Prefixes are stable by convention (`persona_…` for AI
 * agents, `bot_…` for bots, `usr_…` for workspace users).
 */
export function actorTypeFromId(id: string): AuthorType {
  if (id.startsWith("persona_")) return "persona"
  if (id.startsWith("bot_")) return "bot"
  return "user"
}

// One derived index set per distinct `emojis` array identity, not one per
// consumer: `buildShortcodeIndex` walks every emoji AND every alias over the
// ~1,914-entry set, and `useWorkspaceEmoji` is reached three times per rendered
// message row. Keyed by the array the shared workspace-table registry hands out,
// so a new identity means the rows genuinely changed.
const emojiIndexes = new WeakMap<EmojiEntry[], WorkspaceEmojiIndexes>()

const EMPTY_EMOJI_INDEXES: WorkspaceEmojiIndexes = {
  // Safe to share across workspaces: every accessor returns undefined/null.
  workspaceId: null,
  emojis: Object.freeze([]) as unknown as EmojiEntry[],
  emojiWeights: Object.freeze({}) as Record<string, number>,
  getEmoji: () => undefined,
  toEmoji: () => null,
  toShortcode: () => null,
}

/**
 * The cached row shapes (`CachedWorkspaceUser`, `CachedPersona`, `CachedBot`) are
 * declared independently of the wire types, so the maps are keyed on the one
 * field they share and cast on the way out — exactly as the hook did before.
 */
interface ActorRow {
  id: string
}

interface ActorLookupEntry {
  workspaceId: string
  personas: readonly ActorRow[]
  bots: readonly ActorRow[]
  lookup: ActorLookup
}

// Keyed on the users array, not the workspace id: with sharing off every
// consumer holds its own render-stable rows array, so a single slot per
// workspace would be evicted by the next consumer and never hit. One entry per
// distinct rows identity means the shared arm shares an entry and the off arm
// keeps one per consumer. Nested by the emoji resolver because two consumers
// can be handed the same rows array while holding their own emoji indexes (the
// off arm's private live queries), and a single slot per array would then be
// evicted by whichever consumer rendered last, on every render.
let actorLookups = new WeakMap<readonly ActorRow[], WeakMap<(shortcode: string) => string | null, ActorLookupEntry>>()

/**
 * The shortcode index, reverse emoji map and their accessors for one `emojis`
 * array. Rebuilt only when the array or the weights reference changes; every
 * consumer of the same rows gets the same object identity.
 */
export function getWorkspaceEmojiIndexes(
  workspaceId: string,
  emojis: EmojiEntry[],
  emojiWeights: Record<string, number>
): WorkspaceEmojiIndexes {
  // workspaceId and weights participate in the hit: `EMPTY_EMOJIS` is a module
  // singleton shared across workspaces, so an emojis-only key would serve one
  // workspace's weights (quick-bar ranking) to another whose metadata row also
  // lacks an emoji set — the same cross-workspace class getActorLookup guards.
  const cached = emojiIndexes.get(emojis)
  if (cached && cached.workspaceId === workspaceId && cached.emojiWeights === emojiWeights) return cached
  // The pre-resolution empty set is every consumer's first read; indexing it
  // would be a build per mount for a map that can only be empty.
  if (emojis.length === 0 && Object.keys(emojiWeights).length === 0) return EMPTY_EMOJI_INDEXES

  // Times the emoji index build only — the sole producer of this sample, so one
  // sample means one emoji-index rebuild.
  const stopTimer = perfCapture.getPerfCapture().time("actors.lookupBuild")
  const shortcodeIndex = emojiPicker.buildShortcodeIndex(emojis)
  const reverseIndex = new Map<string, string>()
  for (const entry of emojis) reverseIndex.set(entry.emoji, entry.shortcode)
  stopTimer()

  const getEmoji = (shortcode: string): EmojiEntry | undefined =>
    shortcodeIndex.get(emojiPicker.stripShortcodeColons(shortcode))
  const indexes: WorkspaceEmojiIndexes = {
    workspaceId,
    emojis,
    emojiWeights,
    getEmoji,
    toEmoji: (shortcode: string) => getEmoji(shortcode)?.emoji ?? null,
    toShortcode: (emoji: string) => reverseIndex.get(emoji) ?? null,
  }
  emojiIndexes.set(emojis, indexes)
  return indexes
}

/**
 * The actor maps and resolvers for one workspace. The returned object's identity
 * changes only when the users/personas/bots rows or the emoji resolver changed —
 * that stability is what keeps the memoised row tree from re-rendering when
 * unrelated workspace data ticks.
 */
export function getActorLookup(
  workspaceId: string,
  users: readonly ActorRow[],
  personas: readonly ActorRow[],
  bots: readonly ActorRow[],
  toEmoji: (shortcode: string) => string | null
): ActorLookup {
  const byResolver = actorLookups.get(users)
  const cached = byResolver?.get(toEmoji)
  // workspaceId must participate: pre-hydration every workspace passes the same
  // EMPTY_ROWS singletons, and a rows-only hit would serve workspace A's lookup
  // (A's id baked into getActorAvatar) to workspace B's first render.
  if (cached && cached.workspaceId === workspaceId && cached.personas === personas && cached.bots === bots) {
    return cached.lookup
  }

  const userMap = new Map(users.map((u) => [u.id, u as User]))
  const personaMap = new Map(personas.map((p) => [p.id, p as Persona]))
  const botMap = new Map(bots.map((b) => [b.id, b as Bot]))

  const getUser = (userId: string): User | undefined => userMap.get(userId)
  const getPersona = (personaId: string): Persona | undefined => personaMap.get(personaId)
  const getBot = (botId: string): Bot | undefined => botMap.get(botId)

  const getActorName = (actorId: string | null, actorType: AuthorType | null): string => {
    if (!actorId) return "Unknown"
    if (actorType === "system") return "Threa"
    if (actorType === "persona") return personaMap.get(actorId)?.name ?? "AI Companion"
    if (actorType === "bot") return botMap.get(actorId)?.name ?? "Bot"
    return userMap.get(actorId)?.name || actorId.substring(0, 8)
  }

  const getActorInitials = (actorId: string | null, actorType: AuthorType | null): string => {
    if (!actorId) return "?"
    if (actorType === "system") return "T"

    if (actorType === "persona") {
      const persona = personaMap.get(actorId)
      if (persona?.avatarEmoji) {
        const emoji = toEmoji(persona.avatarEmoji)
        if (emoji) return emoji
      }
      return initialsFrom(persona?.name) ?? "AI"
    }

    if (actorType === "bot") {
      const bot = botMap.get(actorId)
      if (bot?.avatarEmoji) {
        const emoji = toEmoji(bot.avatarEmoji)
        if (emoji) return emoji
      }
      return initialsFrom(bot?.name) ?? "B"
    }

    return initialsFrom(userMap.get(actorId)?.name) ?? actorId.substring(0, 2).toUpperCase()
  }

  const getActorAvatar = (actorId: string | null, actorType: AuthorType | null): ActorAvatarInfo => {
    const fallback = getActorInitials(actorId, actorType)

    if (actorType === "system") return { fallback }

    if (actorType === "persona" && actorId) {
      const persona = personaMap.get(actorId)
      const avatarUrl = getPersonaAvatarUrl(workspaceId, persona?.avatarUrl, 64)
      if (avatarUrl) return { fallback, slug: persona?.slug, avatarUrl }
      return { fallback, slug: persona?.slug }
    }

    if (actorType === "bot" && actorId) {
      const bot = getBot(actorId)
      const avatarUrl = getBotAvatarUrl(workspaceId, bot?.avatarUrl, 64)
      if (avatarUrl) return { fallback, avatarUrl }
      return { fallback }
    }

    if (actorId) {
      const workspaceUser = userMap.get(actorId)
      const status = resolveUserStatus(workspaceUser, toEmoji)
      const dnd = resolveUserDnd(workspaceUser)
      const avatarUrl = getAvatarUrl(workspaceId, workspaceUser?.avatarUrl, 64)
      const info: ActorAvatarInfo = { fallback }
      if (avatarUrl) info.avatarUrl = avatarUrl
      if (status) info.status = status
      if (dnd) info.dnd = dnd
      return info
    }

    return { fallback }
  }

  const lookup: ActorLookup = { getActorName, getActorInitials, getActorAvatar, getUser, getPersona, getBot }
  const resolvers = byResolver ?? new WeakMap<(shortcode: string) => string | null, ActorLookupEntry>()
  resolvers.set(toEmoji, { workspaceId, personas, bots, lookup })
  actorLookups.set(users, resolvers)
  return lookup
}

/**
 * Resolve a workspace user's stored status fields into a display status,
 * masking expired/empty ones and converting the emoji shortcode to a glyph.
 * Returns undefined when there is nothing to show. `User` carries the status
 * fields on the wire; cached rows predating the feature simply lack them.
 */
function resolveUserStatus(
  user: User | undefined,
  toEmoji: (shortcode: string) => string | null
): ActorStatus | undefined {
  if (!user) return undefined
  const active = resolveActiveStatus({
    statusEmoji: user.statusEmoji ?? null,
    statusText: user.statusText ?? null,
    statusExpiresAt: user.statusExpiresAt ?? null,
  })
  if (!active) return undefined
  return {
    emoji: active.emoji ? toEmoji(active.emoji) : null,
    text: active.text,
    expiresAt: active.expiresAt,
  }
}

/**
 * The workspace user's active notification pause (do-not-disturb), from either a
 * do-not-disturb status or a manual pause, or null when notifications are
 * flowing. Tolerant of cached rows predating the feature, which lack the fields.
 */
function resolveUserDnd(user: User | undefined): ActiveNotificationPause | null {
  if (!user) return null
  return resolveNotificationPause({
    statusEmoji: user.statusEmoji ?? null,
    statusText: user.statusText ?? null,
    statusExpiresAt: user.statusExpiresAt ?? null,
    statusPausesNotifications: user.statusPausesNotifications ?? false,
    notificationsPausedUntil: user.notificationsPausedUntil ?? null,
    notificationsPausedIndefinitely: user.notificationsPausedIndefinitely ?? false,
  })
}

function initialsFrom(name: string | null | undefined): string | undefined {
  if (!name) return undefined
  const words = name.split(" ")
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
}

/** Drop every memoised lookup — tests and account switches only. */
export function resetActorLookups(): void {
  actorLookups = new WeakMap()
}
