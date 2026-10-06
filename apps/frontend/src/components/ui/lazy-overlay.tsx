import * as React from "react"
import { flushSync } from "react-dom"
import { DropdownMenu, DropdownMenuTrigger } from "./dropdown-menu"
import { HoverCard, HoverCardTrigger } from "./hover-card"
import { Popover, PopoverTrigger } from "./popover"
import { Tooltip, TooltipTrigger } from "./tooltip"

/**
 * Overlays for surfaces that render many triggers at once (timeline rows): the
 * trigger renders bare until its first interaction, then latches into the Radix
 * root for good, because closed Radix roots dominated those surfaces' render cost.
 */

type TriggerElement = React.ReactElement<React.HTMLAttributes<HTMLElement>>
type Replay = (trigger: HTMLElement) => void | (() => void)

function chain<E extends React.SyntheticEvent>(own: ((event: E) => void) | undefined, lazy: (event: E) => void) {
  return (event: E) => {
    own?.(event)
    if (!event.defaultPrevented) lazy(event)
  }
}

/**
 * Arming swaps the bare trigger for the Radix-wrapped one, which remounts its
 * DOM node, so the interaction that armed it is replayed onto the new node.
 * The commit is synchronous so nothing (a pointer leaving, a key press) lands on
 * the detached node in between.
 */
function useArmedTrigger(open = false) {
  const [armed, setArmed] = React.useState(open)
  if (open && !armed) setArmed(true)
  const triggerNode = React.useRef<HTMLElement | null>(null)
  // A callback ref: the asChild trigger may be any element, which a typed RefObject can't express.
  const triggerRef = React.useCallback((node: HTMLElement | null) => {
    triggerNode.current = node
  }, [])
  const pendingReplay = React.useRef<Replay | null>(null)

  React.useLayoutEffect(() => {
    const replay = pendingReplay.current
    pendingReplay.current = null
    if (!armed || !replay) return
    if (!triggerNode.current) {
      console.error("Lazy overlay trigger does not forward its ref to a DOM node; the arming interaction is lost")
      return
    }
    return replay(triggerNode.current)
  }, [armed])

  const arm = (replay: Replay) => {
    pendingReplay.current = replay
    flushSync(() => setArmed(true))
  }
  return { armed, triggerRef, arm }
}

/** About half a second: longer than Chromium takes to re-hit-test a swapped node. */
const HOVER_POLL_FRAMES = 30

const refocus: Replay = (trigger) => {
  trigger.focus()
}

/**
 * Tooltip and hover card arm on pointer entry and on keyboard focus. Touch and
 * pointer-press focus never arm: swapping the node mid-tap would drop the tap's
 * click, and Radix opens neither overlay for them anyway.
 */
function useHoverArmedTrigger(trigger: TriggerElement) {
  const { armed, triggerRef, arm } = useArmedTrigger()
  const entered = React.useRef(false)
  const markEntered = () => {
    entered.current = true
  }
  if (armed) return { triggerRef, markEntered, bareProps: null }

  const bareProps = {
    onPointerEnter: chain(trigger.props.onPointerEnter, (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return
      const init: PointerEventInit = {
        bubbles: true,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        clientX: event.clientX,
        clientY: event.clientY,
      }
      // The swapped-in node gets no pointermove (Radix Tooltip opens on move)
      // and, in Chromium, no boundary events, with `:hover` applied frames later
      // (Radix HoverCard opens on enter, stacking a timer per enter). Replay only
      // once the node is hovered, which guarantees it a real leave; otherwise a
      // fast sweep would open an overlay nothing ever closes.
      arm((node) => {
        let frames = 0
        const tick = () => {
          if (!node.matches(":hover")) {
            if (++frames < HOVER_POLL_FRAMES) frame = requestAnimationFrame(tick)
            return
          }
          // An out from the parent toward the node makes React emit enter on
          // the node alone, not on every ancestor as a null-related over would.
          if (!entered.current) {
            node.parentElement?.dispatchEvent(new PointerEvent("pointerout", { ...init, relatedTarget: node }))
          }
          node.dispatchEvent(new PointerEvent("pointermove", init))
        }
        let frame = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(frame)
      })
    }),
    onFocus: chain(trigger.props.onFocus, (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(":focus-visible")) arm(refocus)
    }),
  }
  return { triggerRef, markEntered, bareProps }
}

interface LazyTooltipProps {
  /** Must forward props and a ref to its DOM node, as `TooltipTrigger asChild` requires. */
  trigger: TriggerElement
  delayDuration?: number
  /** The `TooltipContent`. */
  children: React.ReactNode
}

export function LazyTooltip({ trigger, delayDuration, children }: LazyTooltipProps) {
  const { triggerRef, markEntered, bareProps } = useHoverArmedTrigger(trigger)
  if (bareProps) return React.cloneElement(trigger, bareProps)
  return (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild ref={triggerRef} onPointerEnter={markEntered}>
        {trigger}
      </TooltipTrigger>
      {children}
    </Tooltip>
  )
}

interface LazyHoverCardProps {
  trigger: TriggerElement
  openDelay?: number
  closeDelay?: number
  /** The `HoverCardContent`. */
  children: React.ReactNode
}

export function LazyHoverCard({ trigger, openDelay, closeDelay, children }: LazyHoverCardProps) {
  const { triggerRef, markEntered, bareProps } = useHoverArmedTrigger(trigger)
  if (bareProps) return React.cloneElement(trigger, bareProps)
  return (
    <HoverCard openDelay={openDelay} closeDelay={closeDelay}>
      <HoverCardTrigger asChild ref={triggerRef} onPointerEnter={markEntered}>
        {trigger}
      </HoverCardTrigger>
      {children}
    </HoverCard>
  )
}

interface LazyOpenableProps {
  trigger: TriggerElement
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The overlay's content element. */
  children: React.ReactNode
}

/**
 * Mounts already open on Radix's own open gesture: a primary, non-ctrl
 * pointerdown. Keyboard focus arms it closed instead, so Radix handles the keys
 * itself (its keyboard open focuses the first item).
 */
export function LazyDropdownMenu({ trigger, open, onOpenChange, children }: LazyOpenableProps) {
  const { armed, triggerRef, arm } = useArmedTrigger(open)
  if (!armed) {
    return React.cloneElement(trigger, {
      "aria-haspopup": "menu",
      "aria-expanded": false,
      onPointerDown: chain(trigger.props.onPointerDown, (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0 || event.ctrlKey) return
        // As Radix does: the trigger never takes focus, the menu content does.
        event.preventDefault()
        onOpenChange(true)
      }),
      onFocus: chain(trigger.props.onFocus, () => arm(refocus)),
    })
  }
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild ref={triggerRef}>
        {trigger}
      </DropdownMenuTrigger>
      {children}
    </DropdownMenu>
  )
}

/** Mounts already open on click, Radix Popover's open gesture (keyboard Enter/Space included). */
export function LazyPopover({ trigger, open, onOpenChange, children }: LazyOpenableProps) {
  const { armed, triggerRef } = useArmedTrigger(open)
  if (!armed) {
    return React.cloneElement(trigger, {
      "aria-haspopup": "dialog",
      "aria-expanded": false,
      onClick: chain(trigger.props.onClick, () => onOpenChange(true)),
    })
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild ref={triggerRef}>
        {trigger}
      </PopoverTrigger>
      {children}
    </Popover>
  )
}
