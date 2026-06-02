/**
 * Sidebar configuration — the wire contract for a user's per-workspace sidebar
 * layout. The frontend renders from this object (see
 * `apps/frontend/src/components/layout/sidebar/sidebar-config.ts`, which adds
 * the purely-presentational labels/icons/collapse behavior on top); the backend
 * persists it per (workspace, user) and broadcasts changes for cross-device sync.
 *
 * The layout is a single ordered list of typed **sections**. Quick links are one
 * of those sections (`kind: "quicklinks"`), so the user can position the whole
 * block anywhere among their stream/label sections — or remove it entirely — and
 * the individual links inside it carry their own order + visibility in
 * {@link SidebarConfig.quickLinks}.
 */

/** Smart-view buckets a stream can be sorted into. */
export const SIDEBAR_SECTION_KEYS = ["important", "recent", "pinned", "other"] as const
export type SidebarSectionKey = (typeof SIDEBAR_SECTION_KEYS)[number]

/** Stream types that can back a type-driven section ("All" view). */
export const SIDEBAR_TYPE_SECTIONS = ["scratchpad", "channel", "dm"] as const
export type SidebarTypeSection = (typeof SIDEBAR_TYPE_SECTIONS)[number]

/** Max length of a user-supplied custom-section name (validated on write, trimmed on render). */
export const MAX_CUSTOM_SECTION_NAME_LENGTH = 80

/** What streams a section draws from. Presentation is derived from this at render time. */
export type SidebarSectionSpec =
  | { kind: "smart"; bucket: SidebarSectionKey }
  | { kind: "type"; streamType: SidebarTypeSection }
  /**
   * A label lens: streams the viewer can see that carry this label. Additive —
   * a labeled stream still appears in its smart/type section too. The label's
   * name/color/emoji are resolved from the labels cache at render time, not
   * stored here (only the id, so a renamed/recolored label stays in sync).
   */
  | { kind: "label"; labelId: string }
  /**
   * A user-defined section: a hand-curated set of streams the viewer files here,
   * the lightweight cousin of a label (no shared catalog, no per-stream
   * attribution — the membership lives inline in {@link streamIds}). Unlike a
   * label lens, a custom section is **exclusive and trumps order**: a stream
   * pinned here shows only here, even if a smart/label/type section ordered above
   * it would also match (see `resolveSections`). A stream belongs to at most one
   * custom section — `normalizeSidebarConfig` enforces this, keeping a duplicated
   * id only in the first custom section that lists it.
   */
  | { kind: "custom"; sectionId: string; name: string; streamIds: string[] }
  /**
   * The Quick Links block (Drafts / Saved / Files / …). A position-only marker:
   * the links themselves — their order and per-link visibility — live in
   * {@link SidebarConfig.quickLinks}, independent of this section's placement, so
   * removing and re-adding the section preserves the viewer's link choices.
   */
  | { kind: "quicklinks" }

export interface SidebarSection {
  /** Stable key — also the collapse-state persistence key on the frontend. */
  id: string
  spec: SidebarSectionSpec
}

export const SIDEBAR_BASE_PRESETS = ["smart", "all"] as const
export type SidebarBasePreset = (typeof SIDEBAR_BASE_PRESETS)[number]

/**
 * Quick-link destinations in the sidebar's "Quick Links" block. The user can
 * reorder them and set each one's visibility; the set itself is fixed (these are
 * the workspace's standing views).
 */
export const SIDEBAR_QUICK_LINKS = ["drafts", "saved", "files", "scheduled", "memory", "labels", "activity"] as const
export type SidebarQuickLinkKey = (typeof SIDEBAR_QUICK_LINKS)[number]

/** Stable section id for the Quick Links block — doubles as its collapse-state key. */
export const QUICK_LINKS_SECTION_ID = "quick-links"

/**
 * Quick links that carry a live signal (a count / unread badge). Only these
 * support the "show when active" visibility — the rest are always-on
 * destinations with nothing to gate on, so they're a plain show/hide.
 */
export const SIDEBAR_QUICK_LINKS_WITH_ACTIVE_STATE = ["drafts", "saved", "scheduled", "activity"] as const
export type SidebarActiveQuickLinkKey = (typeof SIDEBAR_QUICK_LINKS_WITH_ACTIVE_STATE)[number]

/** Whether a quick link has a live signal and thus supports "show when active". */
export function quickLinkHasActiveState(key: SidebarQuickLinkKey): key is SidebarActiveQuickLinkKey {
  return (SIDEBAR_QUICK_LINKS_WITH_ACTIVE_STATE as readonly string[]).includes(key)
}

/**
 * A quick link's visibility:
 * - `show`: always visible.
 * - `active`: visible only when the link has a live signal (a count > 0). Valid
 *   only for {@link SIDEBAR_QUICK_LINKS_WITH_ACTIVE_STATE}; coerced to `show`
 *   for links without a signal.
 * - `hidden`: never visible (kept in the list so the editor can re-show it
 *   without losing its position).
 */
export const SIDEBAR_QUICK_LINK_VISIBILITIES = ["show", "active", "hidden"] as const
export type SidebarQuickLinkVisibility = (typeof SIDEBAR_QUICK_LINK_VISIBILITIES)[number]

/** Array position is the link's order; `visibility` is its show/active/hide state. */
export interface SidebarQuickLink {
  key: SidebarQuickLinkKey
  visibility: SidebarQuickLinkVisibility
}

/** All quick links, shown, in canonical order — the preset/seed default. */
export const DEFAULT_QUICK_LINKS: SidebarQuickLink[] = SIDEBAR_QUICK_LINKS.map((key) => ({
  key,
  visibility: "show",
}))

/**
 * Persisted-document version. Bumped when the document shape changes in a way
 * {@link normalizeSidebarConfig} must migrate. v2 introduced the quick-links
 * section + tri-state link visibility; pre-v2 documents are migrated on read.
 */
export const SIDEBAR_CONFIG_VERSION = 2

export interface SidebarConfig {
  /** Document version; absent/legacy documents are treated as v1 and migrated. */
  version: number
  basePreset: SidebarBasePreset
  sections: SidebarSection[]
  quickLinks: SidebarQuickLink[]
}

/** The legacy ({ enabled }) and current ({ visibility }) shapes a stored link can take. */
export type StoredQuickLink = {
  key: SidebarQuickLinkKey
  visibility?: SidebarQuickLinkVisibility
  /** Pre-v2 boolean flag, migrated to {@link SidebarQuickLink.visibility}. */
  enabled?: boolean
}

/**
 * The loose input {@link normalizeSidebarConfig} accepts: a full
 * {@link SidebarConfig} (frontend) or a partially-typed document straight off
 * the wire (backend Zod output, or a pre-v2 row missing `version`/`visibility`).
 * Normalization collapses it to a canonical {@link SidebarConfig}.
 */
export type RawSidebarConfig = {
  version?: number
  basePreset: SidebarBasePreset
  sections?: SidebarSection[]
  quickLinks?: StoredQuickLink[]
}

/**
 * Whether a section's spec is one the renderer knows how to present. The render
 * path (`sectionPresentation`, `resolveSections`) assumes every spec it receives
 * resolves to a known bucket / stream type, so a stale or malformed persisted
 * section — an unknown smart bucket or stream type written by an older client, a
 * label section missing its id — must be dropped on read. Otherwise one bad row
 * takes down the whole sidebar (and the workspace layout it lives in) with a
 * `Cannot read properties of undefined` when the presentation lookup misses.
 *
 * This is the read-time counterpart to the write-time `sidebarSectionSpecSchema`
 * (backend `sidebar-config/handlers.ts`): a new spec `kind` must be added to both
 * — and to the `SidebarSectionSpec` union above — or the backend accepts a spec
 * the renderer silently drops here via the `default` arm.
 */
function isRenderableSectionSpec(spec: SidebarSectionSpec | undefined | null): spec is SidebarSectionSpec {
  if (!spec) return false
  switch (spec.kind) {
    case "smart":
      return (SIDEBAR_SECTION_KEYS as readonly string[]).includes(spec.bucket)
    case "type":
      return (SIDEBAR_TYPE_SECTIONS as readonly string[]).includes(spec.streamType)
    case "label":
      return typeof spec.labelId === "string" && spec.labelId.length > 0
    case "custom":
      // A blank-named section would render an unlabeled, indistinguishable
      // header; streamIds is sanitized separately (see normalizeSidebarConfig).
      return (
        typeof spec.sectionId === "string" &&
        spec.sectionId.length > 0 &&
        typeof spec.name === "string" &&
        spec.name.trim().length > 0
      )
    case "quicklinks":
      return true
    default:
      return false
  }
}

/**
 * Sanitize a custom section's membership: keep only string stream ids, and drop
 * any id already claimed by an earlier custom section so a stream lives in at
 * most one (the write path enforces this too; this guards stray data on read).
 * Mutates `claimed` with the ids it keeps.
 */
function sanitizeCustomStreamIds(streamIds: unknown, claimed: Set<string>): string[] {
  if (!Array.isArray(streamIds)) return []
  const kept: string[] = []
  for (const id of streamIds) {
    if (typeof id !== "string" || id.length === 0 || claimed.has(id)) continue
    claimed.add(id)
    kept.push(id)
  }
  return kept
}

/** Resolve a stored link's visibility, migrating the pre-v2 boolean and coercing invalid `active`. */
function normalizeQuickLinkVisibility(link: StoredQuickLink): SidebarQuickLinkVisibility {
  const stored = link.visibility
  if (stored === "show" || stored === "active" || stored === "hidden") {
    // "active" only makes sense for links with a live signal.
    return stored === "active" && !quickLinkHasActiveState(link.key) ? "show" : stored
  }
  // Pre-v2 documents carried a boolean `enabled` instead of a visibility.
  if (typeof link.enabled === "boolean") return link.enabled ? "show" : "hidden"
  return "show"
}

/**
 * Bring a config to the current shape: a complete, deduped, tri-state quick-link
 * list and a sections list that includes the quick-links block. Idempotent and
 * safe on every read/write boundary.
 *
 * - Quick links: each gets the missing keys appended (shown) in canonical order,
 *   unknown keys dropped, the pre-v2 boolean `enabled` migrated to `visibility`,
 *   and an invalid `active` coerced to `show` — so every destination stays
 *   reachable and a future new link shows up for existing users.
 * - Sections: duplicate ids dropped. A pre-v2 document (version < current) that
 *   never had the quick-links section gets it prepended, so existing users keep
 *   their quick links. A current-version document is left as-is, so a user who
 *   deliberately removed the block keeps it gone.
 */
export function normalizeSidebarConfig(config: RawSidebarConfig): SidebarConfig {
  const storedLinks = config.quickLinks ?? []
  const seen = new Set<SidebarQuickLinkKey>()
  const quickLinks: SidebarQuickLink[] = []
  for (const link of storedLinks) {
    if (SIDEBAR_QUICK_LINKS.includes(link.key) && !seen.has(link.key)) {
      seen.add(link.key)
      quickLinks.push({ key: link.key, visibility: normalizeQuickLinkVisibility(link) })
    }
  }
  for (const key of SIDEBAR_QUICK_LINKS) {
    if (!seen.has(key)) quickLinks.push({ key, visibility: "show" })
  }

  // Drop unrenderable and duplicate sections so the document is safe to render
  // and fully idempotent. An unknown/malformed spec (stale data from an older
  // client) would crash the presentation lookup; two sections sharing an id
  // would trip React keys and the drag list's sortable ids. The write path
  // already validates (Zod) + dedups via addSection; this guards stray data on
  // every read boundary (bootstrap, IDB rehydrate, socket sync).
  const seenSectionIds = new Set<string>()
  let sections = (config.sections ?? []).filter((section) => {
    if (!section || !isRenderableSectionSpec(section.spec)) return false
    if (seenSectionIds.has(section.id)) return false
    seenSectionIds.add(section.id)
    return true
  })

  // Custom-section membership is exclusive: a stream may appear in only one
  // custom section. Sanitize each section's streamIds and enforce single
  // membership across them (first listing wins), so a duplicate written by a
  // racing client can't surface the same stream in two custom sections.
  const claimedCustomStreamIds = new Set<string>()
  sections = sections.map((section) =>
    section.spec.kind === "custom"
      ? {
          ...section,
          spec: { ...section.spec, streamIds: sanitizeCustomStreamIds(section.spec.streamIds, claimedCustomStreamIds) },
        }
      : section
  )

  // v1 → v2: existing users had quick links rendered above their sections, not
  // as a section. Prepend the block so it stays visible after the upgrade. Only
  // for pre-v2 documents — at the current version, an absent block means the
  // user removed it and we must respect that.
  const isPreV2 = (config.version ?? 1) < SIDEBAR_CONFIG_VERSION
  const hasQuickLinksSection = sections.some((s) => s.spec.kind === "quicklinks")
  if (isPreV2 && !hasQuickLinksSection) {
    sections = [{ id: QUICK_LINKS_SECTION_ID, spec: { kind: "quicklinks" } }, ...sections]
  }

  return { ...config, version: SIDEBAR_CONFIG_VERSION, sections, quickLinks }
}

/** Section ids double as collapse-state keys, so they must stay stable. */
export const SMART_SIDEBAR_CONFIG: SidebarConfig = {
  version: SIDEBAR_CONFIG_VERSION,
  basePreset: "smart",
  sections: [
    { id: QUICK_LINKS_SECTION_ID, spec: { kind: "quicklinks" } },
    { id: "important", spec: { kind: "smart", bucket: "important" } },
    { id: "recent", spec: { kind: "smart", bucket: "recent" } },
    { id: "pinned", spec: { kind: "smart", bucket: "pinned" } },
    { id: "other", spec: { kind: "smart", bucket: "other" } },
  ],
  quickLinks: DEFAULT_QUICK_LINKS,
}

export const ALL_SIDEBAR_CONFIG: SidebarConfig = {
  version: SIDEBAR_CONFIG_VERSION,
  basePreset: "all",
  sections: [
    { id: QUICK_LINKS_SECTION_ID, spec: { kind: "quicklinks" } },
    { id: "scratchpads", spec: { kind: "type", streamType: "scratchpad" } },
    { id: "channels", spec: { kind: "type", streamType: "channel" } },
    { id: "dms", spec: { kind: "type", streamType: "dm" } },
  ],
  quickLinks: DEFAULT_QUICK_LINKS,
}

export function sidebarConfigForPreset(preset: SidebarBasePreset): SidebarConfig {
  return preset === "all" ? ALL_SIDEBAR_CONFIG : SMART_SIDEBAR_CONFIG
}

/** Seeded for users who have never customized their sidebar. */
export const DEFAULT_SIDEBAR_CONFIG: SidebarConfig = SMART_SIDEBAR_CONFIG
