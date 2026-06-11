import type { SealedSourceItem } from "@threa/crypto"
import { ChevronRight, FileText } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

/**
 * Citation sources rendered under a decrypted E2E agent reply.
 *
 * For E2E streams the sources ride INSIDE the sealed message payload (the
 * server only ever holds ciphertext — E2EE-9), so the message bubble is the
 * surface that has them after decrypt: trace steps carry their own sealed
 * sources separately (E2EE-14). Plaintext replies surface sources through the
 * trace dialog's `SourceList`; this component is the sealed payload's
 * render-side counterpart, styled after it.
 */
export function MessageSourceList({ sources }: { sources: SealedSourceItem[] }) {
  if (sources.length === 0) return null
  return (
    <Collapsible className="mt-2">
      <CollapsibleTrigger className="flex items-center gap-1.5 py-1 text-left group text-xs text-muted-foreground hover:text-foreground">
        <FileText className="w-3.5 h-3.5" />
        <span className="font-medium">Sources</span>
        <span className="bg-muted px-1.5 py-0.5 rounded-full text-[11px] font-semibold">{sources.length}</span>
        <ChevronRight className="w-3.5 h-3.5 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 rounded-md border border-border/60 bg-muted/30 text-xs">
          {sources.map((source, i) => (
            <div key={i} className={cn("px-2.5 py-1.5", i < sources.length - 1 && "border-b border-border/60")}>
              <div className="font-semibold text-xs">
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {source.title}
                </a>
              </div>
              <div className="text-[11px] text-muted-foreground">{sourceDomain(source.url)}</div>
              {source.snippet && (
                <div className="text-muted-foreground text-[11px] leading-snug line-clamp-2">{source.snippet}</div>
              )}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}
