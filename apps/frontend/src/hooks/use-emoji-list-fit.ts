import { useLayoutEffect, useRef, useState } from "react"
import { fitEmojiListHeight, recentSectionFits } from "@/lib/emoji-picker"

export interface EmojiListFit {
  /** Attach to the recently-used block (measured, and hidden when it would squeeze the grid). */
  recentRef: React.RefObject<HTMLDivElement | null>
  /** Attach to the selected-emoji footer. */
  footerRef: React.RefObject<HTMLDivElement | null>
  listHeight: number
  showRecent: boolean
}

/**
 * Sizes the virtualized emoji list to the vertical space the popup was given,
 * so the popup never grows past the viewport edge.
 *
 * The chrome around the list is measured rather than assumed: the grid gives up
 * height first, and once it is down to `EMOJI_LIST_MIN_HEIGHT` the recently-used
 * block is dropped instead — clipping emoji rows would hide the keyboard
 * selection with nothing on screen to reveal it.
 *
 * The last measured recents height survives the block unmounting, so hiding it
 * can never measure 0 and immediately re-show it.
 */
export function useEmojiListFit(availableHeight: number | null, hasRecent: boolean): EmojiListFit {
  const recentRef = useRef<HTMLDivElement | null>(null)
  const footerRef = useRef<HTMLDivElement | null>(null)
  const lastRecentHeight = useRef(0)
  const [chrome, setChrome] = useState({ recent: 0, footer: 0 })

  useLayoutEffect(() => {
    if (recentRef.current) lastRecentHeight.current = recentRef.current.offsetHeight
    const recent = lastRecentHeight.current
    const footer = footerRef.current?.offsetHeight ?? 0
    setChrome((prev) => (prev.recent === recent && prev.footer === footer ? prev : { recent, footer }))
  })

  const recentHeight = hasRecent ? chrome.recent : 0
  const showRecent = hasRecent && recentSectionFits(availableHeight, recentHeight, chrome.footer)
  const listHeight = fitEmojiListHeight(availableHeight, (showRecent ? recentHeight : 0) + chrome.footer)

  return { recentRef, footerRef, listHeight, showRecent }
}
