import { useState, type ComponentType } from "react"
import { Github, Globe } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ExternalLinkProvider } from "@/lib/external-links"

const MARK_CLASS = "absolute inset-0 size-full"

function LinearMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.1 0C17.59 0 22.85 5.26 22.85 11.75c0 3.335-1.39 6.346-3.622 8.485L2.886 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

const PROVIDER_MARKS = { github: Github, linear: LinearMark } satisfies Record<
  ExternalLinkProvider,
  ComponentType<{ className?: string }>
>

function FallbackMark() {
  return <Globe className={cn(MARK_CLASS, "text-muted-foreground")} />
}

function Favicon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <FallbackMark />
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={cn(MARK_CLASS, "rounded-[3px] object-contain")}
      onError={() => setFailed(true)}
    />
  )
}

function SlotContent({ provider, faviconSrc }: ExternalLinkIconProps) {
  if (provider) {
    const Mark = PROVIDER_MARKS[provider]
    return <Mark className={cn(MARK_CLASS, "text-foreground")} />
  }
  if (faviconSrc) return <Favicon key={faviconSrc} src={faviconSrc} />
  return <FallbackMark />
}

interface ExternalLinkIconProps {
  provider: ExternalLinkProvider | null
  faviconSrc: string | null
}

export function ExternalLinkIcon(props: ExternalLinkIconProps) {
  return (
    // The generated word joiner keeps the icon on the line of the link's first character without entering copied text.
    <span aria-hidden="true" className="whitespace-nowrap after:content-['\2060']">
      <span className="relative mr-[0.28em] inline-block size-[1em] align-[-0.14em]">
        <SlotContent {...props} />
      </span>
    </span>
  )
}
