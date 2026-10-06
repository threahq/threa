import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import type { PaneFocus } from "./pane-focus"

/**
 * Where a `compose:<streamId>` pane takes its stream's composer. The stream's
 * own composer keeps the draft, uploads, quote replies and send, and renders
 * into the pane's node; the pane's floating state rides along, because the
 * composer renders from the stream's place in the tree, not the pane's.
 */
export interface ComposeSlot {
  node: HTMLElement
  paneFocus: PaneFocus | null
}

interface ComposeSlots {
  slot: (streamId: string) => ComposeSlot | null
  setSlot: (streamId: string, slot: ComposeSlot | null) => void
  /** The composer writing into `streamId`'s slot. A stream on show twice writes from one of them. */
  owner: (streamId: string) => symbol | null
  claim: (streamId: string, token: symbol) => () => void
  subscribe: (listener: () => void) => () => void
}

function createComposeSlots(): ComposeSlots {
  const slots = new Map<string, ComposeSlot>()
  const owners = new Map<string, symbol[]>()
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    slot: (streamId) => slots.get(streamId) ?? null,
    setSlot: (streamId, slot) => {
      if (slot) slots.set(streamId, slot)
      else slots.delete(streamId)
      emit()
    },
    owner: (streamId) => owners.get(streamId)?.[0] ?? null,
    claim: (streamId, token) => {
      owners.set(streamId, [...(owners.get(streamId) ?? []), token])
      emit()
      return () => {
        const rest = (owners.get(streamId) ?? []).filter((claimed) => claimed !== token)
        if (rest.length > 0) owners.set(streamId, rest)
        else owners.delete(streamId)
        emit()
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const ComposeSlotsContext = createContext<ComposeSlots | null>(null)

export function ComposeSlotsProvider({ children }: { children: ReactNode }) {
  const [slots] = useState(createComposeSlots)
  return <ComposeSlotsContext.Provider value={slots}>{children}</ComposeSlotsContext.Provider>
}

function useComposeSlots(): ComposeSlots {
  const slots = useContext(ComposeSlotsContext)
  if (!slots) throw new Error("Compose slots must be used within a ComposeSlotsProvider")
  return slots
}

/** The slot this composer renders into while `streamId`'s compose pane is open, or null. */
export function useComposeSlot(streamId: string, active: boolean): ComposeSlot | null {
  const slots = useComposeSlots()
  const [token] = useState(() => Symbol(streamId))
  useLayoutEffect(() => (active ? slots.claim(streamId, token) : undefined), [slots, streamId, token, active])
  const owner = useSyncExternalStore(slots.subscribe, () => slots.owner(streamId))
  const slot = useSyncExternalStore(slots.subscribe, () => slots.slot(streamId))
  return active && owner === token ? slot : null
}

/** Offers `node` to `streamId`'s composer, and whether a composer for it is mounted. */
export function useProvideComposeSlot(streamId: string, slot: ComposeSlot | null): boolean {
  const slots = useComposeSlots()
  useLayoutEffect(() => {
    if (!slot) return
    slots.setSlot(streamId, slot)
    return () => slots.setSlot(streamId, null)
  }, [slots, streamId, slot])
  return useSyncExternalStore(slots.subscribe, () => slots.owner(streamId)) !== null
}
