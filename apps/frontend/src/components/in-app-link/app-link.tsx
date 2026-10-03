import type { ReactNode } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { SlidersHorizontal } from "lucide-react"
import { parseAppLinkHref, type AppLinkDestination } from "@threahq/types"
import { WS_SETTINGS_PARAM } from "@/components/workspace-settings/tab-config"
import { InAppLinkChip } from "./in-app-link-chip"

function resolveAppLinkPath(destination: AppLinkDestination, workspaceId: string, search: URLSearchParams): string {
  if (destination.kind === "page") return `/w/${workspaceId}/${destination.page}`
  const params = new URLSearchParams(search)
  params.set(destination.kind === "settings" ? "settings" : WS_SETTINGS_PARAM, destination.tab)
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
  const destination = parseAppLinkHref(href)
  if (!destination || !workspaceId) return <span>{label}</span>

  const icon = destination.kind === "page" ? undefined : SlidersHorizontal
  return (
    <Link to={resolveAppLinkPath(destination, workspaceId, searchParams)} className="no-underline">
      <InAppLinkChip icon={icon} label={label} />
    </Link>
  )
}
