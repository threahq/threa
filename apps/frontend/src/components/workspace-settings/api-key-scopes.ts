import {
  Bot,
  Eye,
  FileText,
  Hash,
  Lightbulb,
  MessageSquare,
  Paperclip,
  Plug,
  Search,
  Send,
  ShieldCheck,
  Tag,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { API_KEY_ELIGIBLE_SCOPES, WORKSPACE_PERMISSION_SCOPES as S, type WorkspacePermissionSlug } from "@threahq/types"

export type ScopeLevel = "none" | "read" | "write"
/** An area holding some, but not all, of a level's permissions. */
export type AreaLevel = ScopeLevel | "partial"

/** What a key can touch, and the permissions each access level holds. Write includes read. */
export interface ScopeArea {
  id: string
  label: string
  icon: LucideIcon
  read: readonly WorkspacePermissionSlug[]
  /** Empty for an area that can only be read. */
  write: readonly WorkspacePermissionSlug[]
}

export interface ScopeAreaGroup {
  id: string
  label: string
  areas: readonly ScopeArea[]
}

/** Every key-eligible permission, each in exactly one area. */
export const API_KEY_SCOPE_GROUPS: readonly ScopeAreaGroup[] = [
  {
    id: "conversations",
    label: "Conversations",
    areas: [
      { id: "messages", label: "Messages", icon: MessageSquare, read: [S.MESSAGES_READ], write: [S.MESSAGES_WRITE] },
      { id: "search", label: "Search", icon: Search, read: [S.MESSAGES_SEARCH], write: [] },
      { id: "streams", label: "Streams", icon: Hash, read: [S.STREAMS_READ], write: [S.STREAMS_WRITE] },
      { id: "docs", label: "Docs", icon: FileText, read: [S.DOCS_READ], write: [S.DOCS_WRITE] },
      {
        id: "attachments",
        label: "Attachments",
        icon: Paperclip,
        read: [S.ATTACHMENTS_READ],
        write: [S.ATTACHMENTS_WRITE],
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    areas: [
      { id: "people", label: "People", icon: Users, read: [S.USERS_READ], write: [] },
      { id: "memory", label: "Memory", icon: Lightbulb, read: [S.MEMOS_READ], write: [] },
      { id: "labels", label: "Labels", icon: Tag, read: [S.LABELS_READ], write: [S.LABELS_WRITE] },
    ],
  },
  {
    id: "agents",
    label: "Agents",
    areas: [
      {
        id: "delegations",
        label: "Delegations",
        icon: Send,
        read: [S.DELEGATIONS_READ],
        write: [S.DELEGATIONS_WRITE],
      },
      {
        id: "presence",
        label: "Bot presence",
        icon: Bot,
        read: [S.BOT_RUNTIME_READ],
        write: [S.BOT_RUNTIME_WRITE],
      },
      {
        id: "invocations",
        label: "Invocations",
        icon: Zap,
        read: [S.BOT_INVOCATIONS_READ],
        write: [S.BOT_INVOCATIONS_WRITE],
      },
    ],
  },
]

const ALL_AREAS = API_KEY_SCOPE_GROUPS.flatMap((group) => group.areas)

/** What `threa-bot run` needs: presence, claims, replies, reading the stream, files both ways. */
export const CONNECTED_BOT_SCOPES: readonly WorkspacePermissionSlug[] = [
  S.BOT_RUNTIME_READ,
  S.BOT_RUNTIME_WRITE,
  S.BOT_INVOCATIONS_READ,
  S.BOT_INVOCATIONS_WRITE,
  S.MESSAGES_READ,
  S.MESSAGES_WRITE,
  S.STREAMS_READ,
  S.ATTACHMENTS_READ,
  S.ATTACHMENTS_WRITE,
]

interface ScopePreset {
  id: string
  label: string
  icon: LucideIcon
  scopes: readonly WorkspacePermissionSlug[]
}

export const API_KEY_SCOPE_PRESETS: readonly ScopePreset[] = [
  { id: "read-only", label: "Read only", icon: Eye, scopes: ALL_AREAS.flatMap((area) => area.read) },
  { id: "connected-bot", label: "Connected bot", icon: Plug, scopes: CONNECTED_BOT_SCOPES },
  { id: "full", label: "Full access", icon: ShieldCheck, scopes: API_KEY_ELIGIBLE_SCOPES },
]

const ELIGIBLE: ReadonlySet<string> = new Set(API_KEY_ELIGIBLE_SCOPES)

/** How many of the key-eligible permissions `scopes` holds. */
export function eligibleCount(scopes: Iterable<string>): number {
  let count = 0
  for (const scope of scopes) if (ELIGIBLE.has(scope)) count++
  return count
}

export function areaLevel(area: ScopeArea, scopes: ReadonlySet<string>): AreaLevel {
  const held = (slug: string) => scopes.has(slug)
  const readHeld = area.read.filter(held).length
  const writeHeld = area.write.filter(held).length
  if (readHeld === 0 && writeHeld === 0) return "none"
  if (readHeld < area.read.length) return "partial"
  if (writeHeld === 0) return "read"
  return writeHeld === area.write.length ? "write" : "partial"
}

/** The most an area offers at `level`: an area that can only be read stops at read. */
function clampLevel(area: ScopeArea, level: ScopeLevel): ScopeLevel {
  return level === "write" && area.write.length === 0 ? "read" : level
}

export function withAreaLevel<T extends string>(scopes: ReadonlySet<T>, area: ScopeArea, level: ScopeLevel): Set<T> {
  const next = new Set<string>(scopes)
  for (const slug of [...area.read, ...area.write]) next.delete(slug)
  const target = clampLevel(area, level)
  if (target !== "none") for (const slug of area.read) next.add(slug)
  if (target === "write") for (const slug of area.write) next.add(slug)
  return next as Set<T>
}

export function withGroupLevel<T extends string>(scopes: ReadonlySet<T>, group: ScopeAreaGroup, level: ScopeLevel) {
  return group.areas.reduce((next, area) => withAreaLevel(next, area, level), new Set(scopes))
}

/** The level every area of the group is at, or `null` when they differ. */
export function groupLevel(group: ScopeAreaGroup, scopes: ReadonlySet<string>): ScopeLevel | null {
  const levels: ScopeLevel[] = ["none", "read", "write"]
  return (
    levels.find((level) => group.areas.every((area) => areaLevel(area, scopes) === clampLevel(area, level))) ?? null
  )
}

/** The preset holding exactly the key-eligible permissions in `scopes`. */
export function matchingPreset(scopes: ReadonlySet<string>): ScopePreset | null {
  const count = eligibleCount(scopes)
  return API_KEY_SCOPE_PRESETS.find((p) => p.scopes.length === count && p.scopes.every((s) => scopes.has(s))) ?? null
}

/** Areas `scopes` grants anything in, with their level, in picker order. */
export function grantedAreas(scopes: ReadonlySet<string>): { area: ScopeArea; level: Exclude<AreaLevel, "none"> }[] {
  return ALL_AREAS.flatMap((area) => {
    const level = areaLevel(area, scopes)
    return level === "none" ? [] : [{ area, level }]
  })
}
