import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { usePreferences } from "@/contexts"
import {
  QUICK_JUMP_ACTION_ID,
  QUICK_JUMP_SLOT_COUNT,
  getEffectiveKeyBinding,
  isMac,
  isModifierKey,
  matchesBindingModifiers,
  parseKeyBinding,
  quickJumpSlotFromEvent,
} from "@/lib/keyboard-shortcuts"

interface QuickJumpRowSlot {
  /** 1-9, the digit that opens this row. */
  slot: number
  /** `aria-keyshortcuts` value for the row, e.g. "Control+3". */
  keyshortcut: string
}

const QuickJumpContext = createContext<Map<string, QuickJumpRowSlot> | null>(null)

/**
 * The slot assigned to a sidebar row while the modifier is held; `null` the rest
 * of the time, and outside the provider (so a row renders unchanged wherever the
 * sidebar list isn't).
 */
export function useQuickJumpSlot(streamId: string): QuickJumpRowSlot | null {
  return useContext(QuickJumpContext)?.get(streamId) ?? null
}

/**
 * How long the modifier must stay down before the numbers appear. Long enough
 * that tapping through a two-key shortcut (⌘K, ⌘F) never flashes the sidebar,
 * short enough to feel immediate when you're actually looking for a number.
 * Pressing a digit works from the first millisecond regardless.
 */
const REVEAL_DELAY_MS = 180

function buildSlots(ids: string[], binding: string): Map<string, QuickJumpRowSlot> {
  const parsed = parseKeyBinding(binding)
  const modifiers: string[] = []
  if (parsed.mod) modifiers.push(isMac() ? "Meta" : "Control")
  if (parsed.shift) modifiers.push("Shift")
  if (parsed.alt) modifiers.push("Alt")

  const slots = new Map<string, QuickJumpRowSlot>()
  ids.forEach((id, index) => {
    const slot = index + 1
    slots.set(id, { slot, keyshortcut: [...modifiers, String(slot)].join("+") })
  })
  return slots
}

interface SidebarQuickJumpProviderProps {
  workspaceId: string
  /**
   * The first {@link QUICK_JUMP_SLOT_COUNT} stream ids in sidebar render order,
   * deduplicated. Read through a ref, so a new array every render costs nothing.
   */
  order: string[]
  children: ReactNode
}

/**
 * Owns the modifier-hold listener behind the sidebar's number caps.
 *
 * The id→slot mapping is frozen the moment the modifier goes down: sections are
 * activity-sorted, so a message arriving mid-hold would otherwise shuffle the
 * target out from under the digit you're about to press.
 */
export function SidebarQuickJumpProvider({ workspaceId, order, children }: SidebarQuickJumpProviderProps) {
  const navigate = useNavigate()
  const { preferences } = usePreferences()
  const binding = getEffectiveKeyBinding(QUICK_JUMP_ACTION_ID, preferences?.keyboardShortcuts ?? {})

  const orderRef = useRef(order)
  orderRef.current = order
  const heldOrderRef = useRef<string[] | null>(null)
  const [slots, setSlots] = useState<Map<string, QuickJumpRowSlot> | null>(null)

  useEffect(() => {
    if (!binding) return

    let revealTimer: ReturnType<typeof setTimeout> | undefined
    const disarm = () => {
      clearTimeout(revealTimer)
      heldOrderRef.current = null
      setSlots((current) => (current === null ? current : null))
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesBindingModifiers(event, binding)) {
        disarm()
        return
      }

      const slot = quickJumpSlotFromEvent(event, binding)
      if (slot !== null) {
        // The frozen order when held; the live one when the digit beat the hold.
        const streamId = (heldOrderRef.current ?? orderRef.current)[slot - 1]
        if (!streamId) return
        event.preventDefault()
        disarm()
        navigate(`/w/${workspaceId}/s/${streamId}`)
        return
      }

      // Any real key under the modifier is a different shortcut running.
      if (!isModifierKey(event.key)) {
        disarm()
        return
      }
      if (heldOrderRef.current) return

      const held = orderRef.current.slice(0, QUICK_JUMP_SLOT_COUNT)
      heldOrderRef.current = held
      revealTimer = setTimeout(() => setSlots(buildSlots(held, binding)), REVEAL_DELAY_MS)
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!matchesBindingModifiers(event, binding)) disarm()
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    // A held modifier that leaves the window never reports its keyup.
    window.addEventListener("blur", disarm)
    document.addEventListener("visibilitychange", disarm)
    return () => {
      disarm()
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
      window.removeEventListener("blur", disarm)
      document.removeEventListener("visibilitychange", disarm)
    }
  }, [binding, navigate, workspaceId])

  return <QuickJumpContext.Provider value={slots}>{children}</QuickJumpContext.Provider>
}

/**
 * The number a row wears while the modifier is held. Takes the slot the hover
 * "…" menu occupies rather than adding one, so revealing it never reflows a row
 * (INV-21). `aria-hidden`: the row itself carries `aria-keyshortcuts`.
 */
export function QuickJumpCap({ slot }: { slot: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md bg-muted-foreground/15 font-mono text-[11px] font-semibold leading-none text-muted-foreground"
    >
      {slot}
    </span>
  )
}

/**
 * Collects the sidebar's first {@link QUICK_JUMP_SLOT_COUNT} stream ids as the
 * list renders. A stream that appears in two sections (Unread and its home)
 * keeps the slot of its first row; both rows wear that number.
 */
export function createQuickJumpCollector() {
  const ids: string[] = []
  const seen = new Set<string>()
  return {
    ids,
    add(streamId: string) {
      if (ids.length >= QUICK_JUMP_SLOT_COUNT || seen.has(streamId)) return
      seen.add(streamId)
      ids.push(streamId)
    },
  }
}
