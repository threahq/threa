import { useLayoutEffect, useRef, useState } from "react"
import { fitEmojiListHeight } from "@/lib/emoji-picker"

export interface EmojiListFit {
  /** Attach to the popup root (the element carrying the available-height clamp). */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** Attach to the wrapper whose height is `listHeight`. */
  listRef: React.RefObject<HTMLDivElement | null>
  listHeight: number
}

/**
 * Sizes the virtualized emoji list to whatever vertical space the popup was
 * given, so the popup never grows past the viewport edge.
 *
 * The chrome around the list (recently-used rows, search, preview footer) is
 * measured rather than assumed, so adding chrome shrinks the list instead of
 * pushing the popup off-screen. `scrollHeight` — not `offsetHeight` — because
 * the container is clamped to the available height, and only the unclamped
 * content height reveals the real chrome.
 */
export function useEmojiListFit(availableHeight: number | null): EmojiListFit {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [chromeHeight, setChromeHeight] = useState(0)

  useLayoutEffect(() => {
    const container = containerRef.current
    const list = listRef.current
    if (!container || !list) return
    const measured = container.scrollHeight - list.offsetHeight
    setChromeHeight((prev) => (prev === measured ? prev : measured))
  })

  return { containerRef, listRef, listHeight: fitEmojiListHeight(availableHeight, chromeHeight) }
}
