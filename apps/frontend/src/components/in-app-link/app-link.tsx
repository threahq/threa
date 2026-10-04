import type { ReactNode } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { SlidersHorizontal } from "lucide-react"
import {
  APP_LINK_GO_ROUTE,
  APP_LINK_SCHEME,
  isKnownQuickLinkKey,
  parseAppLinkHref,
  type AppLinkDestination,
  type AppLinkPage,
  type SettingsTab,
  type SidebarQuickLinkKey,
} from "@threahq/types"
import { QUICK_LINK_META } from "@/components/layout/sidebar/quick-links"
import { SETTINGS_TAB_CONFIG } from "@/components/settings/tab-config"
import { WORKSPACE_SETTINGS_TAB_CONFIG, WS_SETTINGS_PARAM } from "@/components/workspace-settings/tab-config"
import { useOptionalSettings } from "@/contexts"
import { InAppLinkChip } from "./in-app-link-chip"

const NON_QUICK_LINK_PAGE_LABELS: Record<Exclude<AppLinkPage, SidebarQuickLinkKey>, string> = {
  board: "Board",
  search: "Search",
  "app-status": "App status",
}

/** The `app:` href a same-origin `/go/<place>` path stands for, or null for any other path. */
export function appLinkHrefFromGoPath(path: string): string | null {
  const prefix = `${APP_LINK_GO_ROUTE}/`
  if (!path.startsWith(prefix)) return null
  return `${APP_LINK_SCHEME}${path.slice(prefix.length).split(/[?#]/)[0]}`
}

/** The destination's name as the app shows it, for a link that carries no label of its own. */
export function appLinkDestinationLabel(destination: AppLinkDestination): string {
  if (destination.kind === "settings") return `Settings: ${SETTINGS_TAB_CONFIG[destination.tab].label}`
  if (destination.kind === "workspace-settings") {
    return `Workspace settings: ${WORKSPACE_SETTINGS_TAB_CONFIG[destination.tab].label}`
  }
  const { page } = destination
  return isKnownQuickLinkKey(page) ? QUICK_LINK_META[page].label : NON_QUICK_LINK_PAGE_LABELS[page]
}

function resolveAppLinkPath(
  destination: AppLinkDestination,
  workspaceId: string,
  search: URLSearchParams,
  getSettingsUrl: ((tab: SettingsTab) => string) | undefined
): string | null {
  if (destination.kind === "page") return `/w/${workspaceId}/${destination.page}`
  if (destination.kind === "settings") return getSettingsUrl?.(destination.tab) ?? null
  const params = new URLSearchParams(search)
  params.set(WS_SETTINGS_PARAM, destination.tab)
  return `?${params.toString()}`
}

/**
 * An `app:` href from an agent or the user guide, as a chip that opens the
 * destination. Settings open over the current view, the way every other
 * settings entry point does. An href outside the registry, or one rendered
 * outside a workspace, stays inert text rather than a dead link.
 */
export function AppLink({ href, label }: { href: string; label: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [searchParams] = useSearchParams()
  const settings = useOptionalSettings()
  const destination = parseAppLinkHref(href)
  const path =
    destination && workspaceId
      ? resolveAppLinkPath(destination, workspaceId, searchParams, settings?.getSettingsUrl)
      : null
  if (!destination || !path) return <span>{label}</span>

  const icon = destination.kind === "page" ? undefined : SlidersHorizontal
  return (
    <Link to={path} className="no-underline">
      <InAppLinkChip icon={icon} label={label} />
    </Link>
  )
}
