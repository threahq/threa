import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { loadE2eKeyForUser } from "@/stores/e2e-session-store"
import { PassphraseSetupModal } from "./passphrase-setup-modal"
import { PassphraseUnlockModal } from "./passphrase-unlock-modal"

interface OpenUnlockOptions {
  /** Pre-check the "keep me unlocked on this device" box. Inline entry points
   *  default to `true`; Settings passes `false`. */
  defaultTrustDevice?: boolean
  onUnlocked?: () => void
}

interface OpenSetupOptions {
  defaultTrustDevice?: boolean
}

export interface E2eUnlockContextValue {
  openUnlock: (opts?: OpenUnlockOptions) => void
  openSetup: (opts?: OpenSetupOptions) => void
}

const E2eUnlockContext = createContext<E2eUnlockContextValue | null>(null)

/** Throwing accessor — for surfaces guaranteed to render inside the provider. */
export function useE2eUnlock(): E2eUnlockContextValue {
  const ctx = useContext(E2eUnlockContext)
  if (!ctx) throw new Error("useE2eUnlock must be used within an E2eUnlockProvider")
  return ctx
}

/**
 * Non-throwing accessor for affordances (stream header, composer notice) that
 * may also be mounted in unit harnesses without the provider — they render
 * nothing when the context is absent.
 */
export function useE2eUnlockOptional(): E2eUnlockContextValue | null {
  return useContext(E2eUnlockContext)
}

/**
 * Workspace-level owner of the E2E unlock/setup modals. Mounted once in the
 * workspace layout so:
 *   1. the session is hydrated app-wide on load — a trusted device resumes
 *      `unlocked` without the user opening Settings first, and
 *   2. any surface (stream header, composer, settings) can trigger the shared
 *      modals via `useE2eUnlock()` instead of each owning its own copy.
 */
export function E2eUnlockProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const userId = useWorkspaceUserId(workspaceId)
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [unlockDefaultTrust, setUnlockDefaultTrust] = useState(true)
  const [setupDefaultTrust, setSetupDefaultTrust] = useState(true)
  const onUnlockedRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (userId) void loadE2eKeyForUser(workspaceId, userId)
  }, [workspaceId, userId])

  const openUnlock = useCallback((opts?: OpenUnlockOptions) => {
    setUnlockDefaultTrust(opts?.defaultTrustDevice ?? true)
    onUnlockedRef.current = opts?.onUnlocked ?? null
    setUnlockOpen(true)
  }, [])

  const openSetup = useCallback((opts?: OpenSetupOptions) => {
    setSetupDefaultTrust(opts?.defaultTrustDevice ?? true)
    setSetupOpen(true)
  }, [])

  const value = useMemo<E2eUnlockContextValue>(() => ({ openUnlock, openSetup }), [openUnlock, openSetup])

  return (
    <E2eUnlockContext.Provider value={value}>
      {children}
      {userId && (
        <>
          <PassphraseUnlockModal
            open={unlockOpen}
            workspaceId={workspaceId}
            userId={userId}
            defaultTrustDevice={unlockDefaultTrust}
            onOpenChange={setUnlockOpen}
            onUnlocked={() => onUnlockedRef.current?.()}
          />
          <PassphraseSetupModal
            open={setupOpen}
            workspaceId={workspaceId}
            userId={userId}
            defaultTrustDevice={setupDefaultTrust}
            onOpenChange={setSetupOpen}
          />
        </>
      )}
    </E2eUnlockContext.Provider>
  )
}
