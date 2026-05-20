import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Copy, Check, ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD } from "@threa/types"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { useBlockCollapse } from "./use-block-collapse"
import { useMeasuredLineCount } from "./use-measured-line-count"
import { ensureHighlight, tryHighlightSync } from "./highlighter"

interface CodeBlockProps {
  language: string
  children: string
}

/** Format language name for display */
function formatLanguage(lang: string): string {
  const displayNames: Record<string, string> = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    python: "Python",
    java: "Java",
    go: "Go",
    rust: "Rust",
    cpp: "C++",
    csharp: "C#",
    ruby: "Ruby",
    php: "PHP",
    swift: "Swift",
    kotlin: "Kotlin",
    html: "HTML",
    css: "CSS",
    scss: "SCSS",
    json: "JSON",
    yaml: "YAML",
    xml: "XML",
    markdown: "Markdown",
    sql: "SQL",
    bash: "Bash",
    shell: "Shell",
    dockerfile: "Dockerfile",
    graphql: "GraphQL",
    plaintext: "Plain text",
  }
  return displayNames[lang] || lang
}

export default function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  // Preferences context may not exist in all rendering contexts (e.g. tests).
  const preferencesContext = usePreferencesOptional()
  const threshold = preferencesContext?.preferences?.codeBlockCollapseThreshold ?? DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD

  const trimmedCode = useMemo(() => children.trim(), [children])

  // Always render the full code (highlighted) and clamp it with CSS when
  // collapsed — that lets us measure the real rendered height and keeps
  // expanding instant (no re-highlight on toggle).
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // Sync-first: warmed highlighter returns HTML on first render, skipping the
  // placeholder → highlighted swap that caused row remeasure jumps. Cold path
  // (still booting or unknown language) falls through to the effect below.
  const syncHtml = useMemo(() => tryHighlightSync(trimmedCode, language), [trimmedCode, language])
  const [html, setHtml] = useState<string | null>(syncHtml)
  // Captured once on mount: did we hit the cold path? If yes, we'll fade the
  // highlighted output in when it eventually arrives. Hot path renders chrome
  // and code together with no animation.
  const renderedColdRef = useRef(syncHtml === null)

  const measured = useMeasuredLineCount(bodyRef, [trimmedCode, html])
  const lineCount = measured.lineCount
  // Same "more than threshold" semantic as before, but measured by rendered
  // line-height (not "\n" count). The extra half line keeps a barely-over
  // block from sprouting a toggle that would only hide a sliver — and it is
  // exactly the half line the collapsed view shows as the "there's more" hint.
  const collapsible = lineCount !== null && lineCount > threshold + 0.5
  const displayLineCount = lineCount !== null ? Math.max(1, Math.round(lineCount)) : 0

  const { collapsed, canToggle, toggle } = useBlockCollapse({
    kind: "code",
    hashNamespace: language,
    content: trimmedCode,
    collapsible,
  })

  const collapsedMaxHeight =
    collapsed && measured.lineHeightPx !== null ? (threshold + 0.5) * measured.lineHeightPx : undefined

  const handleCopy = useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation()
      try {
        await navigator.clipboard.writeText(trimmedCode)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        // Clipboard API failed, silently ignore
      }
    },
    [trimmedCode]
  )

  useEffect(() => {
    if (syncHtml !== null) {
      setHtml(syncHtml)
      return
    }

    setHtml(null)

    let cancelled = false
    ensureHighlight(trimmedCode, language).then((result) => {
      if (cancelled) return
      if (result !== null) {
        setHtml(result)
        return
      }
      // ensureHighlight returns null only when shiki itself can't render —
      // singleton init failed and even the plaintext fallback threw. Render
      // escaped raw text inside the chrome so the block stays readable and
      // accessible instead of collapsing to the invisible placeholder.
      const escaped = trimmedCode.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      setHtml(`<pre><code>${escaped}</code></pre>`)
    })

    return () => {
      cancelled = true
    }
  }, [syncHtml, trimmedCode, language])

  const toggleLabel = collapsed
    ? `Expand ${displayLineCount} line${displayLineCount === 1 ? "" : "s"}`
    : "Collapse code block"

  const header = (
    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-muted/50 border-b border-border">
      <button
        type="button"
        onClick={toggle}
        disabled={!canToggle}
        aria-expanded={!collapsed}
        aria-label={toggleLabel}
        title={toggleLabel}
        className={cn(
          "flex items-center gap-1 min-w-0 flex-1 text-left",
          "text-[11px] font-medium text-muted-foreground font-mono",
          canToggle ? "hover:text-foreground cursor-pointer" : "cursor-default",
          "disabled:cursor-default"
        )}
      >
        {canToggle &&
          (collapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          ))}
        <span className="truncate">{formatLanguage(language)}</span>
        {collapsed && (
          <span className="text-muted-foreground/80 font-normal shrink-0">
            — {displayLineCount} line{displayLineCount === 1 ? "" : "s"}, click to expand
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded transition-all duration-150 shrink-0",
          "opacity-0 group-hover:opacity-100",
          copied
            ? "bg-green-500/15 text-green-600 dark:text-green-400"
            : "text-muted-foreground hover:bg-primary/15 hover:text-primary"
        )}
        title={copied ? "Copied!" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  )

  // A collapsed block always has a toggle (collapsible ⇒ canToggle), so the
  // clamped body is also a click target for expanding.
  const bodyExpandable = collapsed && canToggle
  const bodyClickHandler = bodyExpandable ? toggle : undefined

  return (
    <div
      className="group my-2 rounded-md overflow-hidden border border-border bg-muted/50 select-text [-webkit-touch-callout:default]"
      data-native-context="true"
    >
      {header}
      {/* py-2 lives on this non-measured wrapper so bodyRef.scrollHeight is
       * exactly lines × line-height — see useMeasuredLineCount. */}
      <div className="relative py-2">
        <div
          ref={bodyRef}
          className={cn("text-xs leading-snug", collapsed && "overflow-hidden", bodyExpandable && "cursor-pointer")}
          style={collapsedMaxHeight !== undefined ? { maxHeight: collapsedMaxHeight } : undefined}
          onClick={bodyClickHandler}
        >
          {html ? (
            <div
              className={cn(
                "[&>pre]:m-0 [&>pre]:px-2.5 [&>pre]:py-0 [&>pre]:text-xs [&>pre]:leading-snug [&>pre]:overflow-x-auto [&>pre]:bg-transparent",
                // Fade in only when we previously rendered the invisible
                // placeholder (cold path). Hot-path first render skips
                // animation so chrome and code appear together.
                renderedColdRef.current && "animate-in fade-in duration-200"
              )}
              // Safe: Shiki generates this HTML internally from the code string - no user HTML passthrough
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            /* Matches shiki's font sizing/line-height so the row keeps the
             * right height (and measures correctly) while highlight loads.
             * `invisible` keeps it in layout without flashing raw code. */
            <pre
              className="m-0 px-2.5 py-0 overflow-x-auto text-xs font-mono leading-snug invisible"
              aria-hidden="true"
            >
              <code>{trimmedCode}</code>
            </pre>
          )}
        </div>
        {collapsed && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-transparent to-muted/50"
          />
        )}
      </div>
    </div>
  )
}
