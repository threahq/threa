import { useEffect, useState } from "react"
import { DEBUG_FOCUS_LOG_EVENT, debugFocusEnabled } from "@/lib/debug-focus"

/**
 * TEMPORARY diagnostic overlay for PR #1880 (see lib/debug-focus.ts).
 * Renders nothing unless the page was loaded with `?debugFocus`.
 */

function describeNode(target: EventTarget | null): string {
  if (!target) return "null"
  if (!(target instanceof Element)) return target === document ? "doc" : "win"
  const el = target as HTMLElement
  const type = el.getAttribute("data-type")
  const firstClass = el.classList.item(0)
  let label = ""
  if (type) label = `[${type}]`
  else if (firstClass) label = `.${firstClass}`
  return `${el.tagName.toLowerCase()}${label}${el.isContentEditable ? "+ce" : ""}`
}

export function DebugFocusOverlay() {
  const [lines, setLines] = useState<string[]>([])

  useEffect(() => {
    if (!debugFocusEnabled) return
    const push = (line: string) =>
      setLines((prev) => [...prev.slice(-11), `${((performance.now() % 100_000) / 1000).toFixed(2)} ${line}`])
    const onFocusIn = (e: FocusEvent) => push(`focusin ${describeNode(e.target)}`)
    const onFocusOut = (e: FocusEvent) => push(`focusout ${describeNode(e.target)} > ${describeNode(e.relatedTarget)}`)
    const onLog = (e: Event) => push((e as CustomEvent<string>).detail)
    const vv = window.visualViewport
    const onResize = () => push(`vv ${Math.round(vv?.height ?? 0)}`)
    document.addEventListener("focusin", onFocusIn, true)
    document.addEventListener("focusout", onFocusOut, true)
    window.addEventListener(DEBUG_FOCUS_LOG_EVENT, onLog)
    vv?.addEventListener("resize", onResize)
    return () => {
      document.removeEventListener("focusin", onFocusIn, true)
      document.removeEventListener("focusout", onFocusOut, true)
      window.removeEventListener(DEBUG_FOCUS_LOG_EVENT, onLog)
      vv?.removeEventListener("resize", onResize)
    }
  }, [])

  if (!debugFocusEnabled || lines.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-1 top-12 z-[9999] rounded bg-black/75 p-1 font-mono text-[10px] leading-tight text-lime-300">
      {lines.map((line, index) => (
        <div key={index}>{line}</div>
      ))}
    </div>
  )
}
