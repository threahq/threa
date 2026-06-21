import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { useLongPress } from "@/hooks/use-long-press"
import { useCoarsePointer } from "@/hooks/use-pointer"

// The grown label's left padding; the box is offset left by this much so its
// padded text lands exactly on the original element's left edge — the name
// stays put and the background grows around it rather than jumping sideways.
const PAD_PX = 12

interface PreviewAnchorProps {
  // Callback ref (not a RefObject): contravariant, so the same props spread onto
  // a button, an anchor, or a span without per-element ref typing.
  ref: React.RefCallback<HTMLElement>
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchCancel: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onClickCapture: (e: React.MouseEvent) => void
  style: React.CSSProperties
}

// Hold-to-preview must not trip the browser's native text selection / iOS
// callout on the held label — the gesture is "reveal the name", not "select
// it". Touch-only (anchorProps is null on fine pointers), so desktop selection
// is untouched. The tap-to-edit / open / navigate action still fires on release.
const ANCHOR_STYLE: React.CSSProperties = {
  WebkitUserSelect: "none",
  userSelect: "none",
  WebkitTouchCallout: "none",
}

interface UseStreamTitlePreviewResult {
  /** Spread onto the truncated element. `null` on a fine pointer (no-op). */
  anchorProps: PreviewAnchorProps | null
  /** The grown-name overlay; render it anywhere (it portals itself). */
  overlay: ReactNode
}

// Where and how to grow, measured at press time. When the label sits inside a
// title bar (<header>) the overlay portals into that bar as an absolute child —
// so it IS the bar, inheriting its exact height/background and escaping the
// inner overflow-hidden wrappers — spanning from the name to the bar's right
// edge. Without a bar ancestor it falls back to a viewport-fixed box.
interface PreviewAnchor {
  target: HTMLElement
  inBar: boolean
  /** Name's left: relative to the bar when inBar, else the viewport. */
  left: number
  /** Viewport top / label height — used only by the fixed fallback. */
  top: number
  height: number
}

/**
 * Touch-only press-and-hold preview of a truncated label. Returns props to
 * spread onto the truncated element and an overlay that expands the title bar in
 * place: the full name grows out of the label's position, fills the bar, and
 * covers the controls to its right, then collapses on release. A popover below
 * would sit under the thumb; growing the bar keeps the revealed text where the
 * eye already is. No-op on fine pointers, where width / hover tooltips cover it.
 */
export function useStreamTitlePreview(name: string): UseStreamTitlePreviewResult {
  const isTouch = useCoarsePointer()
  const [anchor, setAnchor] = useState<PreviewAnchor | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const setAnchorEl = useCallback<React.RefCallback<HTMLElement>>((node) => {
    anchorRef.current = node
  }, [])
  // True between long-press firing and the trailing synthetic click, so we can
  // swallow that click — without it a hold-to-preview on an interactive label
  // would also fire its tap action (rename / open profile / navigate) on release.
  const firedRef = useRef(false)

  const longPress = useLongPress({
    onLongPress: () => {
      firedRef.current = true
      const el = anchorRef.current
      if (!el) return
      const labelRect = el.getBoundingClientRect()
      // Both title bars (stream header, side-panel header) are <header>.
      const bar = el.closest("header")
      if (bar) {
        setAnchor({
          target: bar,
          inBar: true,
          left: labelRect.left - bar.getBoundingClientRect().left,
          top: 0,
          height: 0,
        })
      } else {
        setAnchor({
          target: document.body,
          inBar: false,
          left: labelRect.left,
          top: labelRect.top,
          height: labelRect.height,
        })
      }
    },
    enabled: isTouch,
  })

  if (!isTouch) return { anchorProps: null, overlay: null }

  const close = () => setAnchor(null)
  const anchorProps: PreviewAnchorProps = {
    ref: setAnchorEl,
    style: ANCHOR_STYLE,
    onTouchStart: (e) => {
      firedRef.current = false
      longPress.handlers.onTouchStart(e)
    },
    onTouchEnd: () => {
      longPress.handlers.onTouchEnd()
      close()
    },
    onTouchMove: (e) => longPress.handlers.onTouchMove(e),
    onTouchCancel: () => {
      longPress.handlers.onTouchCancel()
      close()
    },
    onContextMenu: (e) => longPress.handlers.onContextMenu(e),
    onClickCapture: (e) => {
      if (firedRef.current) {
        firedRef.current = false
        e.preventDefault()
        e.stopPropagation()
      }
    },
  }

  const left = anchor ? Math.max(anchor.left - PAD_PX, 0) : 0
  const overlay =
    anchor &&
    createPortal(
      <div
        // bg-background + no card chrome so it reads as the bar expanding, not a
        // floating label. pointer-events-none: the finger is still down on the
        // label; the overlay must never intercept the touch / its release.
        className={cn(
          "pointer-events-none flex items-center bg-background text-foreground origin-left animate-in fade-in-0 zoom-in-95 duration-150",
          // In-bar: absolute child of the <header>, pinned top + right so it
          // fills the bar height and covers everything from the name rightward.
          anchor.inBar ? "absolute right-0 top-0 z-10" : "fixed z-50"
        )}
        style={{
          left,
          paddingLeft: PAD_PX,
          paddingRight: 16,
          ...(anchor.inBar
            ? { minHeight: "100%" }
            : {
                top: anchor.top,
                minHeight: anchor.height,
                maxWidth: `calc(100vw - ${left}px)`,
              }),
        }}
      >
        <span className="break-words text-base font-semibold">{name}</span>
      </div>,
      anchor.target
    )

  return { anchorProps, overlay }
}

interface StreamTitlePreviewProps {
  /** The full, untruncated name to reveal while held. */
  name: string
  /** The truncated title element (`<h1>`, button, …) to grow from. */
  children: ReactElement
}

type SpreadableProps = PreviewAnchorProps & { children?: ReactNode }

/**
 * Wrapper form of {@link useStreamTitlePreview} for a self-contained title that
 * isn't already inside an `asChild` slot. Clones the single child with the
 * anchor props. For elements composed under Radix `asChild` (breadcrumb steps),
 * use the hook and spread `anchorProps` onto the leaf yourself.
 */
export function StreamTitlePreview({ name, children }: StreamTitlePreviewProps): ReactNode {
  const { anchorProps, overlay } = useStreamTitlePreview(name)

  if (!anchorProps || !isValidElement(children)) return children

  const child = Children.only(children) as ReactElement<SpreadableProps>
  const enhanced = cloneElement<SpreadableProps>(child, anchorProps)

  return (
    <>
      {enhanced}
      {overlay}
    </>
  )
}
