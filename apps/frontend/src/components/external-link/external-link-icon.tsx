import { useState } from "react"
import type { ExternalLinkProvider } from "@/lib/external-links"

const MARK_CLASS = "absolute inset-0 size-full"
const GLYPH_CLASS = `${MARK_CLASS} external-link-mark`

const GLYPH_CLASSES = {
  github: `${GLYPH_CLASS} external-link-icon-github text-foreground`,
  linear: `${GLYPH_CLASS} external-link-icon-linear text-foreground`,
  globe: `${GLYPH_CLASS} external-link-icon-globe text-muted-foreground`,
} satisfies Record<ExternalLinkProvider | "globe", string>

function Favicon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <span className={GLYPH_CLASSES.globe} />
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={`${MARK_CLASS} rounded-[3px] object-contain`}
      onError={() => setFailed(true)}
    />
  )
}

function SlotContent({ provider, faviconSrc }: ExternalLinkIconProps) {
  if (provider) return <span className={GLYPH_CLASSES[provider]} />
  if (faviconSrc) return <Favicon key={faviconSrc} src={faviconSrc} />
  return <span className={GLYPH_CLASSES.globe} />
}

interface ExternalLinkIconProps {
  provider: ExternalLinkProvider | null
  faviconSrc: string | null
}

export function ExternalLinkIcon(props: ExternalLinkIconProps) {
  return (
    // The generated word joiner keeps the icon on the line of the link's first character without entering copied text;
    // select-none keeps the icon itself out of a copied selection.
    <span aria-hidden="true" className="select-none whitespace-nowrap after:content-['\2060']">
      <span className="relative mr-[0.28em] inline-block size-[1em] align-[-0.14em]">
        <SlotContent {...props} />
      </span>
    </span>
  )
}
