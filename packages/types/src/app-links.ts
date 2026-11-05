import { SETTINGS_TABS, type SettingsTab } from "./preferences"

/** Workspace pages an `app:` link can open, each the route segment under `/w/:workspaceId`. */
export const APP_LINK_PAGES = [
  "activity",
  "agenda",
  "board",
  "drafts",
  "files",
  "labels",
  "memory",
  "saved",
  "scheduled",
  "search",
  "streams",
  "app-status",
] as const
export type AppLinkPage = (typeof APP_LINK_PAGES)[number]

/**
 * Where an `app:` link points. Guide articles and agents use these instead of
 * `/w/…` paths because they hold no workspace id, and settings open over the
 * current view instead of navigating away from it.
 */
export type AppLinkDestination = { kind: "page"; page: AppLinkPage } | { kind: "settings"; tab: SettingsTab }

/**
 * Pages an `app:` link may open, legacy hrefs included. Workspace AI shows
 * only to admins and Early access only to viewers with a feature on early; a
 * link to a page its reader can't see opens the overview instead.
 */
export const APP_LINK_SETTINGS_TABS = SETTINGS_TABS.filter((tab) => tab !== "workspace-ai" && tab !== "early-access")

/**
 * Where the tabs of the two settings dialogs that preceded the one settings
 * window live now. Agent messages and guide articles already sent hold these
 * hrefs, so they keep resolving.
 */
export const LEGACY_SETTINGS_TABS = {
  settings: {
    dictation: "voice",
    calls: "voice",
    schedule: "datetime",
    accessibility: "appearance",
    diagnostics: "privacy",
  },
  "workspace-settings": {
    general: "workspace",
    schedule: "workspace-defaults",
    statuses: "workspace-defaults",
    dictation: "workspace-defaults",
    users: "members",
    members: "members",
    personas: "workspace-ai",
    "ai-agents": "workspace-ai",
    integrations: "integrations",
    bots: "bots",
    "api-keys": "developer",
    "feature-flags": "early-access",
  },
} as const satisfies Record<"settings" | "workspace-settings", Record<string, SettingsTab>>

export const APP_LINK_SCHEME = "app:"

/** App route that opens an `app:` place from outside the app, such as the public guide: `/go/settings/notifications`. */
export const APP_LINK_GO_ROUTE = "/go"

function isOneOf<T extends string>(values: readonly T[], value: string | undefined): value is T {
  return value !== undefined && (values as readonly string[]).includes(value)
}

/** Parses `app:settings/notifications` or `app:memory`; null for anything else. */
export function parseAppLinkHref(href: string): AppLinkDestination | null {
  if (!href.startsWith(APP_LINK_SCHEME)) return null
  const [head, tab, ...rest] = href.slice(APP_LINK_SCHEME.length).split("/")
  if (rest.length > 0) return null
  if ((head === "settings" || head === "workspace-settings") && tab !== undefined) {
    const legacy: Record<string, SettingsTab> = LEGACY_SETTINGS_TABS[head]
    const resolved = Object.hasOwn(legacy, tab) ? legacy[tab] : head === "settings" ? tab : undefined
    return isOneOf(APP_LINK_SETTINGS_TABS, resolved) ? { kind: "settings", tab: resolved } : null
  }
  return tab === undefined && isOneOf(APP_LINK_PAGES, head) ? { kind: "page", page: head } : null
}
