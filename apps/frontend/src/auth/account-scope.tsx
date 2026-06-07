import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { QueryClient } from "@tanstack/react-query"
import { API_BASE } from "@/api/client"
import { ThreaDatabase } from "@/db"
// Imported from the module directly, not the @/db barrel: AccountScope is the
// sole writer of the active-db pointer, so the mutator is intentionally kept
// off the shared barrel (INV-9 — single-owner scope bridge).
import { setActiveDb } from "@/db/database"
import { makeQueryClient } from "@/contexts/query-client"
import { resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { resetStreamStoreCache } from "@/stores/stream-store"
import { resetDraftStoreCache } from "@/stores/draft-store"
import { resetShareHandoffStoreCache } from "@/stores/share-handoff-store"
import { resetE2eSessionStoreCache } from "@/stores/e2e-session-store"
import { resetRevealGate } from "@/sync/reveal-gate"
import { useAuth } from "./hooks"

const NO_ACCOUNT_KEY = "__no_account__"
const PRE_AUTH_ID = "__pre_auth__"
const AUTH_CHANNEL = "threa-auth"

interface SwitchedMessage {
  type: "switched"
  activeWorkosUserId: string
}

export interface AccountScopeValue {
  /** The active account's WorkOS user id, or null pre-auth. */
  activeWorkosUserId: string | null
  /** The active account's IndexedDB handle. */
  getDb: () => ThreaDatabase
  /** The active account's TanStack QueryClient. */
  getQueryClient: () => QueryClient
  /**
   * Flip the active account in place (no page reload). Calls the PR-3
   * `/api/accounts/switch` contract, then triggers the keyed remount so the
   * whole per-account subtree (db, QueryClient, socket, SyncEngine) swaps
   * atomically, and broadcasts to other tabs.
   */
  switchAccount: (targetUserId: string) => Promise<void>
  /** Namespace a storage key to the active account. */
  scopedKey: (suffix: string) => string
}

const AccountScopeContext = createContext<AccountScopeValue | null>(null)

export function useAccountScope(): AccountScopeValue {
  const ctx = useContext(AccountScopeContext)
  if (!ctx) {
    throw new Error("useAccountScope must be used within an AccountScopeProvider")
  }
  return ctx
}

/**
 * Optional variant for leaf contexts (sidebar, push, preferences) that are
 * also mounted in isolation by unit tests without the provider. Returns null
 * outside a provider so those callers fall back to un-namespaced behavior.
 */
export function useAccountScopeOptional(): AccountScopeValue | null {
  return useContext(AccountScopeContext)
}

// Module-level store caches survive a React remount, so a switch must flush
// them or account A's cached workspaces/drafts/shares bleed into account B.
function flushModuleStoreCaches(): void {
  resetWorkspaceStoreCache()
  resetStreamStoreCache()
  resetDraftStoreCache()
  resetShareHandoffStoreCache()
  resetE2eSessionStoreCache()
  resetRevealGate()
}

interface AccountScopeProviderProps {
  children: ReactNode
}

export function AccountScopeProvider({ children }: AccountScopeProviderProps) {
  const { user } = useAuth()
  const authUserId = user?.id ?? null

  // A programmatic / cross-tab switch moves the scope ahead of the cookie
  // identity until the next /api/auth/me catches up; the scope is derived from
  // the switch, never blocked on auth re-fetch.
  const [switchedId, setSwitchedId] = useState<string | null>(null)
  const effectiveId = switchedId ?? authUserId

  // Collapse the transient switch override back into the cookie identity. On
  // logout / session-loss (`authUserId` → null, no navigation — see
  // auth/context.tsx 401 path) this drops the scope so a parked account's
  // db/QueryClient is never served while unauthenticated; once /api/auth/me
  // catches up to a programmatic switch (`switchedId === authUserId`) it
  // retires the redundant override so a later logout can't strand a stale id.
  useEffect(() => {
    if (authUserId === null) {
      setSwitchedId(null)
      return
    }
    if (switchedId === authUserId) {
      setSwitchedId(null)
    }
  }, [authUserId, switchedId])

  const dbRegistry = useRef(new Map<string, ThreaDatabase>())
  const qcRegistry = useRef(new Map<string, QueryClient>())

  const resolveDb = useCallback((id: string): ThreaDatabase => {
    let inst = dbRegistry.current.get(id)
    if (!inst) {
      inst = new ThreaDatabase(`threa_${id}`)
      dbRegistry.current.set(id, inst)
    }
    return inst
  }, [])

  const resolveQueryClient = useCallback((id: string): QueryClient => {
    let qc = qcRegistry.current.get(id)
    if (!qc) {
      qc = makeQueryClient()
      qcRegistry.current.set(id, qc)
    }
    return qc
  }, [])

  // Redirect the shared `db` proxy at the active account *before* the keyed
  // subtree (and its useLiveQuery / SyncEngine) renders. Idempotent registry
  // lookup + pointer move; intentionally render-time so the swap is atomic
  // w.r.t. children mounting (see db/database.ts INV-9 note). Pre-auth we
  // leave the default "threa" handle in place.
  if (effectiveId) {
    setActiveDb(resolveDb(effectiveId))
  }

  const effectiveIdRef = useRef(effectiveId)
  effectiveIdRef.current = effectiveId
  const channelRef = useRef<BroadcastChannel | null>(null)

  useEffect(() => {
    const channel = new BroadcastChannel(AUTH_CHANNEL)
    channelRef.current = channel
    channel.onmessage = (e: MessageEvent) => {
      const data = e.data as Partial<SwitchedMessage> | null
      if (data?.type !== "switched" || !data.activeWorkosUserId) return
      const current = effectiveIdRef.current
      if (data.activeWorkosUserId === current) return
      // Abort in-flight queries on the now-stale client so a late response
      // can never land in the orphaned cache. Storage isolation (distinct DB
      // name + distinct QueryClient) makes correctness independent of timing;
      // this is purely to stop wasted work.
      if (current) qcRegistry.current.get(current)?.cancelQueries()
      flushModuleStoreCaches()
      setSwitchedId(data.activeWorkosUserId)
    }
    return () => {
      channel.close()
      channelRef.current = null
    }
  }, [])

  const switchAccount = useCallback(async (targetUserId: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/api/accounts/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ targetUserId }),
    })
    if (!res.ok) {
      throw new Error(`Account switch failed (${res.status})`)
    }
    const { activeUserId } = (await res.json()) as { activeUserId: string }
    flushModuleStoreCaches()
    setSwitchedId(activeUserId)
    channelRef.current?.postMessage({ type: "switched", activeWorkosUserId: activeUserId } satisfies SwitchedMessage)
  }, [])

  const registryId = effectiveId ?? PRE_AUTH_ID
  const getDb = useCallback(() => resolveDb(registryId), [resolveDb, registryId])
  const getQueryClient = useCallback(() => resolveQueryClient(registryId), [resolveQueryClient, registryId])
  const scopedKey = useCallback((suffix: string) => `${effectiveId ?? NO_ACCOUNT_KEY}:${suffix}`, [effectiveId])

  const value: AccountScopeValue = {
    activeWorkosUserId: effectiveId,
    getDb,
    getQueryClient,
    switchAccount,
    scopedKey,
  }

  // Keyed remount boundary: changing the active account unmounts the old
  // per-account subtree and mounts a fresh one — atomic swap of QueryClient,
  // socket, SyncEngine, and every useState/useRef/useLiveQuery below it.
  return (
    <AccountScopeContext.Provider value={value}>
      <ScopedRoot key={effectiveId ?? NO_ACCOUNT_KEY}>{children}</ScopedRoot>
    </AccountScopeContext.Provider>
  )
}

function ScopedRoot({ children }: { children: ReactNode }) {
  return <>{children}</>
}
