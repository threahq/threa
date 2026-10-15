import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import type { PaneFocus } from "./pane-focus"

/**
 * Where a `compose:<draftKey>` pane takes its draft's composer. The composer
 * that owns the draft (a stream's, a board card's) keeps the draft, uploads,
 * quote replies and send, and renders into the pane's node; the pane's floating
 * state rides along, because the composer renders from its own place in the
 * tree, not the pane's.
 */
export interface ComposeSlot {
  node: HTMLElement
  paneFocus: PaneFocus | null
}

interface ComposeSlots {
  slot: (draftKey: string) => ComposeSlot | null
  setSlot: (draftKey: string, slot: ComposeSlot | null) => void
  /** The composer writing into `draftKey`'s slot. A draft on show twice writes from one of them. */
  owner: (draftKey: string) => symbol | null
  claim: (draftKey: string, token: symbol) => () => void
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
    slot: (draftKey) => slots.get(draftKey) ?? null,
    setSlot: (draftKey, slot) => {
      if (slot) slots.set(draftKey, slot)
      else slots.delete(draftKey)
      emit()
    },
    owner: (draftKey) => owners.get(draftKey)?.[0] ?? null,
    claim: (draftKey, token) => {
      owners.set(draftKey, [...(owners.get(draftKey) ?? []), token])
      emit()
      return () => {
        const rest = (owners.get(draftKey) ?? []).filter((claimed) => claimed !== token)
        if (rest.length > 0) owners.set(draftKey, rest)
        else owners.delete(draftKey)
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

/** The slot this composer renders into while `draftKey`'s compose pane is open, or null. */
export function useComposeSlot(draftKey: string, active: boolean): ComposeSlot | null {
  const slots = useComposeSlots()
  const [token] = useState(() => Symbol(draftKey))
  useLayoutEffect(() => (active ? slots.claim(draftKey, token) : undefined), [slots, draftKey, token, active])
  const owner = useSyncExternalStore(slots.subscribe, () => slots.owner(draftKey))
  const slot = useSyncExternalStore(slots.subscribe, () => slots.slot(draftKey))
  return active && owner === token ? slot : null
}

/** Offers `node` to `draftKey`'s composer, and whether a composer for it is mounted. */
export function useProvideComposeSlot(draftKey: string, slot: ComposeSlot | null): boolean {
  const slots = useComposeSlots()
  useLayoutEffect(() => {
    if (!slot) return
    slots.setSlot(draftKey, slot)
    return () => slots.setSlot(draftKey, null)
  }, [slots, draftKey, slot])
  return useSyncExternalStore(slots.subscribe, () => slots.owner(draftKey)) !== null
}
