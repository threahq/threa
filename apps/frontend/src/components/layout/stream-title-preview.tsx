import { Children, cloneElement, isValidElement, useRef, useState, type ReactElement, type ReactNode } from "react"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useLongPress } from "@/hooks/use-long-press"
import { useCoarsePointer } from "@/hooks/use-pointer"

interface StreamTitlePreviewProps {
  /** The full, untruncated name to reveal while held. */
  name: string
  /** The truncated title element (`<h1>`, button, …) to anchor against. */
  children: ReactElement
}

type TouchHandlerProps = Pick<
  React.DOMAttributes<Element>,
  "onTouchStart" | "onTouchEnd" | "onTouchMove" | "onTouchCancel" | "onContextMenu" | "onClickCapture"
>

function chain<E>(theirs: ((e: E) => void) | undefined, ours: (e: E) => void) {
  return (e: E) => {
    ours(e)
    theirs?.(e)
  }
}

/**
 * Touch-only: press-and-hold the truncated stream title to reveal the full
 * name in a popover until release. The header title is almost always
 * truncated on phones, and there is no hover to fall back on. Renders the
 * child untouched on fine pointers (desktop relies on width / breadcrumbs).
 */
export function StreamTitlePreview({ name, children }: StreamTitlePreviewProps): ReactNode {
  const isTouch = useCoarsePointer()
  const [open, setOpen] = useState(false)
  // True between long-press firing and the trailing synthetic click, so we can
  // swallow that click — without it a hold-to-preview on the scratchpad/DM
  // title would also trigger its tap action (rename / open profile) on release.
  const firedRef = useRef(false)

  const longPress = useLongPress({
    onLongPress: () => {
      firedRef.current = true
      setOpen(true)
    },
    enabled: isTouch,
  })

  if (!isTouch || !isValidElement(children)) return children

  const child = Children.only(children) as ReactElement<TouchHandlerProps>
  const childProps = child.props
  const enhanced = cloneElement<TouchHandlerProps>(child, {
    onTouchStart: chain(childProps.onTouchStart, (e) => {
      firedRef.current = false
      longPress.handlers.onTouchStart(e as React.TouchEvent)
    }),
    onTouchEnd: chain(childProps.onTouchEnd, () => {
      longPress.handlers.onTouchEnd()
      setOpen(false)
    }),
    onTouchMove: chain(childProps.onTouchMove, (e) => longPress.handlers.onTouchMove(e as React.TouchEvent)),
    onTouchCancel: chain(childProps.onTouchCancel, () => {
      longPress.handlers.onTouchCancel()
      setOpen(false)
    }),
    onContextMenu: chain(childProps.onContextMenu, (e) => longPress.handlers.onContextMenu(e as React.MouseEvent)),
    onClickCapture: chain(childProps.onClickCapture, (e) => {
      if (firedRef.current) {
        firedRef.current = false
        e.preventDefault()
        e.stopPropagation()
      }
    }),
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{enhanced}</PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-auto max-w-[80vw] p-3"
        // Finger is still down; don't pull focus or let the originating touch
        // be read as an outside press that immediately dismisses the preview.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <p className="break-words text-sm font-semibold text-foreground">{name}</p>
      </PopoverContent>
    </Popover>
  )
}
