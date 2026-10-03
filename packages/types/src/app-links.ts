import { SETTINGS_TABS, type SettingsTab } from "./preferences"

export const WORKSPACE_SETTINGS_TABS = [
  "general",
  "schedule",
  "statuses",
  "dictation",
  "users",
  "ai-agents",
  "integrations",
  "bots",
  "api-keys",
  "feature-flags",
] as const
export type WorkspaceSettingsTab = (typeof WORKSPACE_SETTINGS_TABS)[number]

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
export type AppLinkDestination =
  | { kind: "page"; page: AppLinkPage }
  | { kind: "settings"; tab: SettingsTab }
  | { kind: "workspace-settings"; tab: WorkspaceSettingsTab }

/**
 * Tabs an `app:` link may open. Diagnostics, feature flags and AI agents show
 * only for some viewers, and a link to a hidden tab silently opens another one.
 */
export const APP_LINK_SETTINGS_TABS = SETTINGS_TABS.filter((tab) => tab !== "diagnostics")
export const APP_LINK_WORKSPACE_SETTINGS_TABS = WORKSPACE_SETTINGS_TABS.filter(
  (tab) => tab !== "feature-flags" && tab !== "ai-agents"
)

export const APP_LINK_SCHEME = "app:"

function isOneOf<T extends string>(values: readonly T[], value: string | undefined): value is T {
  return value !== undefined && (values as readonly string[]).includes(value)
}

/** Parses `app:settings/notifications`, `app:workspace-settings/bots` or `app:memory`; null for anything else. */
export function parseAppLinkHref(href: string): AppLinkDestination | null {
  if (!href.startsWith(APP_LINK_SCHEME)) return null
  const [head, tab, ...rest] = href.slice(APP_LINK_SCHEME.length).split("/")
  if (rest.length > 0) return null
  if (head === "settings") return isOneOf(APP_LINK_SETTINGS_TABS, tab) ? { kind: "settings", tab } : null
  if (head === "workspace-settings") {
    return isOneOf(APP_LINK_WORKSPACE_SETTINGS_TABS, tab) ? { kind: "workspace-settings", tab } : null
  }
  return tab === undefined && isOneOf(APP_LINK_PAGES, head) ? { kind: "page", page: head } : null
}
