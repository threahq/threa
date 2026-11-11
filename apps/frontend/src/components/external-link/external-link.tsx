import type { ReactNode } from "react"
import { useParams } from "react-router-dom"
import { linkFaviconUrl } from "@/api"
import type { ExternalLinkDescription } from "@/lib/external-links"
import { useLinkPreviewContext } from "@/lib/markdown/link-preview-context"
import { ExternalLinkIcon } from "./external-link-icon"

interface ExternalLinkProps {
  href: string
  link: ExternalLinkDescription
  /** The label is the URL itself, so the link's compact label may stand in for it. */
  bare: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
  children: ReactNode
}

export function ExternalLink({ href, link, bare, onMouseEnter, onMouseLeave, children }: ExternalLinkProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const faviconHosts = useLinkPreviewContext()?.faviconHosts
  const faviconSrc =
    workspaceId && faviconHosts?.has(link.faviconHost) ? linkFaviconUrl(workspaceId, link.faviconHost) : null

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="group/link text-primary no-underline hover:text-primary/80"
    >
      <ExternalLinkIcon provider={link.provider} faviconSrc={faviconSrc} />
      {/* Not break-all: Firefox then breaks before the first character and strands the icon. */}
      <span className="underline-offset-4 [overflow-wrap:anywhere] group-hover/link:underline group-focus-visible/link:underline [&_span]:[text-decoration:inherit]">
        {bare && link.compactLabel ? link.compactLabel : children}
      </span>
    </a>
  )
}
