import type { ReactNode } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { SlidersHorizontal } from "lucide-react"
import { parseAppLinkHref, type AppLinkDestination, type SettingsTab } from "@threahq/types"
import { WS_SETTINGS_PARAM } from "@/components/workspace-settings/tab-config"
import { useOptionalSettings } from "@/contexts"
import { InAppLinkChip } from "./in-app-link-chip"

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
