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
}

interface UseStreamTitlePreviewResult {
  /** Spread onto the truncated element. `null` on a fine pointer (no-op). */
  anchorProps: PreviewAnchorProps | null
  /** The grown-name overlay; render it anywhere (portals to the body). */
  overlay: ReactNode
}

/**
 * Touch-only press-and-hold preview of a truncated label. Returns props to
 * spread onto the truncated element and an overlay that grows the full name in
 * place out of that element's position, overlaying its surroundings, then
 * collapses on release. A popover below would sit under the thumb; growing in
 * place keeps the revealed text beside the finger. No-op on fine pointers,
 * where width / hover tooltips already cover it.
 */
export function useStreamTitlePreview(name: string): UseStreamTitlePreviewResult {
  const isTouch = useCoarsePointer()
  const [rect, setRect] = useState<DOMRect | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const setAnchor = useCallback<React.RefCallback<HTMLElement>>((node) => {
    anchorRef.current = node
  }, [])
  // True between long-press firing and the trailing synthetic click, so we can
  // swallow that click — without it a hold-to-preview on an interactive label
  // would also fire its tap action (rename / open profile / navigate) on release.
  const firedRef = useRef(false)

  const longPress = useLongPress({
    onLongPress: () => {
      firedRef.current = true
      if (anchorRef.current) setRect(anchorRef.current.getBoundingClientRect())
    },
    enabled: isTouch,
  })

  if (!isTouch) return { anchorProps: null, overlay: null }

  const close = () => setRect(null)
  const anchorProps: PreviewAnchorProps = {
    ref: setAnchor,
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

  const overlay =
    rect &&
    createPortal(
      <div
        // pointer-events-none: the finger is still down on the label; the
        // overlay must never intercept the ongoing touch / its release.
        className="pointer-events-none fixed z-50 flex items-center rounded-md border bg-popover px-3 text-popover-foreground shadow-md origin-left animate-in fade-in-0 zoom-in-95 duration-150"
        style={{
          left: rect.left - PAD_PX,
          top: rect.top,
          minHeight: rect.height,
          maxWidth: `calc(100vw - ${Math.max(rect.left - PAD_PX, 0)}px - 0.5rem)`,
        }}
      >
        <span className="break-words text-base font-semibold">{name}</span>
      </div>,
      document.body
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
