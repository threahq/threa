import { createContext, useContext, useMemo, type ReactNode } from "react"
import { sharedMessageSlotKey, type SharedMessageSlot, type SlotMap } from "@threa/types"

interface SlotsContextValue {
  getSharedMessage: (messageId: string) => SharedMessageSlot | null
}

const SlotsCtx = createContext<SlotsContextValue | null>(null)

/**
 * Provides the timeline's canonical slot map to any descendant `SharedMessageView`
 * NodeView. The map lives on the stream bootstrap / event-list response (normalized
 * to canonical keys by `lib/slots`) and is plumbed in by the timeline container.
 * The lookup derives the namespaced `shared:<messageId>` key centrally and narrows
 * to the shared-message slot type; a miss returns `null` so the view renders the
 * pre-hydration skeleton rather than crash.
 */
export function SlotsProvider({ map, children }: { map: SlotMap | undefined | null; children: ReactNode }) {
  const value = useMemo<SlotsContextValue>(() => {
    const snapshot = map ?? {}
    return {
      getSharedMessage: (messageId: string) => {
        const slot = snapshot[sharedMessageSlotKey(messageId)]
        return slot && slot.type === "sharedMessage" ? slot : null
      },
    }
  }, [map])
  return <SlotsCtx.Provider value={value}>{children}</SlotsCtx.Provider>
}

export function useSharedMessageSlot(messageId: string): SharedMessageSlot | null {
  const ctx = useContext(SlotsCtx)
  if (!ctx) return null
  return ctx.getSharedMessage(messageId)
}
