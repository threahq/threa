import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { QueryClient } from "@tanstack/react-query"
import { API_BASE } from "@/api/client"
import { FallbackLoader } from "@/components/fallback-loader"
import { ErrorView } from "@/components/error-view"
import { Button } from "@/components/ui/button"
import { accountHomePath } from "@/lib/last-workspace"
import { ThreaDatabase, accountDbName } from "@/db"
// Imported from the module directly, not the @/db barrel: AccountScope is the
// sole writer of the active-db pointer, so the mutator is intentionally kept
// off the shared barrel (INV-9 — single-owner scope bridge).
import { setActiveDb } from "@/db/database"
import { makeQueryClient } from "@/contexts/query-client"
import { resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { resetWorkspaceTableRegistry } from "@/stores/workspace-table-registry"
import { resetActorLookups } from "@/stores/actor-lookup"
import { bumpAccountGeneration } from "@/db/event-writes"
import { resetStreamStoreCache } from "@/stores/stream-store"
import { resetDraftStoreCache } from "@/stores/draft-store"
import { resetDraftContextCache } from "@/hooks/use-board-draft-context"
import { resetShareHandoffStoreCache } from "@/stores/composer-handoff-store"
import { resetComposeOverlayStoreCache } from "@/stores/compose-overlay-store"
import { resetBoardFlashStoreCache } from "@/stores/board-flash-store"
import { resetAsideStoreCache } from "@/stores/aside-store"
import { resetBoardUnreadLatches } from "@/stores/board-unread-latch-store"
import { resetConversationMessageSnapshots } from "@/stores/conversation-messages-store"
import { resetReferenceSourceStoreCache } from "@/stores/reference-source-store"
import { resetSnippetRequestStoreCache } from "@/stores/snippet-request-store"
import { resetConversationReplyOpenStoreCache } from "@/stores/conversation-reply-open-store"
import { resetE2eSessionStoreCache } from "@/stores/e2e-session-store"
import { resetCallStoreCache } from "@/stores/call-store"
import { clearCallLifecycleLog } from "@/calls/lifecycle-log"
import { resetIncomingCallStoreCache } from "@/stores/incoming-call-store"
import { resetFloatingSurfaceGeometryStoreCache } from "@/stores/floating-surface-geometry-store"
import { resetRevealGate } from "@/sync/reveal-gate"
import { resetUploadManager } from "@/lib/uploads/upload-manager"
import { isRetirementCurrent, retireAccountWork } from "@/sync/account-fence"
import { resetRowConfirmations } from "@/sync/bootstrap-diff"
import { useAuth } from "./hooks"
import type { User } from "./types"

const NO_ACCOUNT_KEY = "__no_account__"
const PRE_AUTH_ID = "__pre_auth__"
const AUTH_CHANNEL = "threa-auth"

interface SwitchedMessage {
  type: "switched"
  activeWorkosUserId: string
}

export interface SwitchAccountOptions {
  /**
   * The destination's display identity, when the caller already holds it (the
   * switcher reads it from `/api/accounts`). Passing it means the first paint
   * under the new scope — including a message composed immediately after —
   * already carries the destination's identity instead of waiting a round trip.
   */
  identity?: User | null
  /**
   * Where the destination account lands.
   *
   * - `"account-home"` (default) leaves the outgoing account's URL behind for
   *   the destination's own last workspace. An explicit switch is a change of
   *   viewer, not of place: the previous account's stream is not somewhere the
   *   destination asked to be, and it is usually a 403 for them.
   * - `"keep-location"` keeps the current URL, for an entry the destination
   *   account was explicitly sent to and is authorized for (a notification
   *   deep link, a workspace link resolved to its owning account).
   */
  landing?: "account-home" | "keep-location"
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
   * `/api/accounts/switch` contract, then retires the outgoing account's work
   * and triggers the keyed remount so identity, db, QueryClient, socket and
   * SyncEngine swap atomically, and broadcasts to other tabs.
   */
  switchAccount: (targetUserId: string, opts?: SwitchAccountOptions) => Promise<void>
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
  resetWorkspaceTableRegistry()
  resetActorLookups()
  // The `db` proxy is repointed on a switch, so any write deferred past this
  // point would land in the new account's database — deferred writers capture
  // this generation and bail when it moves.
  bumpAccountGeneration()
  resetRowConfirmations()
  resetStreamStoreCache()
  resetDraftStoreCache()
  resetDraftContextCache()
  resetShareHandoffStoreCache()
  resetSnippetRequestStoreCache()
  resetReferenceSourceStoreCache()
  resetConversationReplyOpenStoreCache()
  resetE2eSessionStoreCache()
  resetComposeOverlayStoreCache()
  resetBoardFlashStoreCache()
  resetAsideStoreCache()
  resetBoardUnreadLatches()
  resetConversationMessageSnapshots()
  // Ordered hangup before state drop: the call-store reset emits leave, closes
  // the transport, and stops tracks (the CallManager's registered hangup) so an
  // account switch with a live call never leaves the prior account's mic hot.
  resetCallStoreCache()
  clearCallLifecycleLog()
  resetIncomingCallStoreCache()
  resetFloatingSurfaceGeometryStoreCache()
  resetRevealGate()
  // Aborts live transfers and drops the in-memory jobs; the persisted bytes
  // stay in the outgoing account's database and resume when it returns.
  resetUploadManager()
}

interface AccountScopeProviderProps {
  children: ReactNode
  /**
   * Router navigation, injected because this provider sits above the router.
   * Used only to land a switched-to account on its own home; it resolves when
   * the destination route is committed, and the subtree stays unmounted until
   * then so no route belonging to the outgoing account renders under the new
   * account's storage.
   */
  landAt: (path: string) => void | Promise<unknown>
}

// A landing that never settles (a route chunk that fails to load) must not leave
// the app on the splash forever. Revealing anyway was worse: the account is
// right but the URL is the outgoing account's, so the app looks like it worked
// and shows the wrong place. Say so and offer the retry instead.
const LANDING_TIMEOUT_MS = 5000

function LandingFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center">
      <ErrorView
        title="Couldn't open this account"
        description="You're signed in to the right account, but we couldn't reach its home page."
      >
        <Button onClick={onRetry}>Try again</Button>
      </ErrorView>
    </div>
  )
}

export function AccountScopeProvider({ children, landAt }: AccountScopeProviderProps) {
  // AuthProvider owns which account is active — for identity and for storage
  // alike. Deriving the scope from anything else is what let a switched-to
  // account render under the previous account's display identity.
  const { activeWorkosUserId: effectiveId, activateAccount } = useAuth()

  const [pendingLanding, setPendingLanding] = useState<{ owner: string; path: string } | null>(null)
  const landingOwner = useRef<string | null>(null)
  const [landingFailed, setLandingFailed] = useState(false)
  const [landingAttempt, setLandingAttempt] = useState(0)
  // The account whose subtree is currently mounted, and a nonce that lets the
  // provider remount that subtree without changing account. `null` means
  // nothing is adopted yet, which `null`-the-account-id cannot express.
  const [adopted, setAdopted] = useState<{ id: string | null } | null>(null)
  const [resumeNonce, setResumeNonce] = useState(0)

  const dbRegistry = useRef(new Map<string, ThreaDatabase>())
  const qcRegistry = useRef(new Map<string, QueryClient>())

  const resolveDb = useCallback((id: string): ThreaDatabase => {
    let inst = dbRegistry.current.get(id)
    if (!inst) {
      inst = new ThreaDatabase(accountDbName(id))
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

  // The subtree belongs to `adopted.id`; while that differs from the active
  // account there is nothing safe to render, so it is hidden until the handover
  // below completes.
  const handingOver = adopted === null || adopted.id !== effectiveId

  // The one account-change handover — this tab's switch, another tab's
  // broadcast, a revalidation that discovers the browser moved on without it.
  // It runs after commit, never during render, for two reasons that both cost
  // us a bug: the module-store resets emit synchronously to live
  // `useSyncExternalStore` subscribers (a render-phase update), and the
  // outgoing subtree is still mounted during the render that discovers the
  // change — moving the `db` proxy there pointed its unmount cleanups at the
  // incoming account's database. By the time this effect runs the outgoing
  // subtree is gone, so its last writes landed in its own database, and the
  // incoming one has not mounted, so no frame pairs the new identity with the
  // previous account's data.
  useEffect(() => {
    if (adopted && adopted.id === effectiveId) return
    const outgoing = adopted?.id ?? null
    if (outgoing) {
      // Abort in-flight queries on the now-stale client so a late response
      // can never land in the orphaned cache. Storage isolation (distinct DB
      // name + distinct QueryClient) makes correctness independent of timing;
      // this is purely to stop wasted work.
      qcRegistry.current.get(outgoing)?.cancelQueries()
      flushModuleStoreCaches()
      if (landingOwner.current !== effectiveId) {
        landingOwner.current = effectiveId
        setPendingLanding(effectiveId ? { owner: effectiveId, path: accountHomePath(effectiveId) } : null)
        setLandingFailed(false)
      }
    }
    // Redirect the shared `db` proxy at the active account before the keyed
    // subtree (and its useLiveQuery / SyncEngine) mounts. Pre-auth keeps the
    // default "threa" handle in place.
    if (effectiveId) setActiveDb(resolveDb(effectiveId))
    setAdopted({ id: effectiveId })
  }, [adopted, effectiveId, resolveDb])

  const effectiveIdRef = useRef(effectiveId)
  effectiveIdRef.current = effectiveId
  const channelRef = useRef<BroadcastChannel | null>(null)

  /**
   * The one account-change lifecycle: retire the outgoing account's work, hand
   * the new identity to its owner, and hold the subtree until the destination
   * has somewhere of its own to land. Every entry point (this tab's switch,
   * another tab's broadcast) goes through it.
   */
  const adoptAccount = useCallback(
    (targetUserId: string, identity: User | null, landing: "account-home" | "keep-location") => {
      landingOwner.current = targetUserId
      activateAccount(targetUserId, identity)
      setLandingFailed(false)
      setPendingLanding(
        landing === "account-home" ? { owner: targetUserId, path: accountHomePath(targetUserId) } : null
      )
    },
    [activateAccount]
  )

  useEffect(() => {
    const channel = new BroadcastChannel(AUTH_CHANNEL)
    channelRef.current = channel
    channel.onmessage = (e: MessageEvent) => {
      const data = e.data as Partial<SwitchedMessage> | null
      if (data?.type !== "switched" || !data.activeWorkosUserId) return
      if (data.activeWorkosUserId === effectiveIdRef.current) return
      // Another tab's deep-link intent is not this tab's: whatever this tab was
      // showing belonged to the outgoing account, so it lands on the
      // destination's home.
      adoptAccount(data.activeWorkosUserId, null, "account-home")
    }
    return () => {
      channel.close()
      channelRef.current = null
    }
  }, [adoptAccount])

  useEffect(() => {
    if (!pendingLanding || pendingLanding.owner !== effectiveId) return
    let settled = false
    const finish = (landed: boolean) => {
      if (settled) return
      settled = true
      if (landed) setPendingLanding(null)
      else setLandingFailed(true)
    }
    const timer = setTimeout(() => finish(false), LANDING_TIMEOUT_MS)
    void Promise.resolve(landAt(pendingLanding.path)).then(
      () => finish(true),
      () => finish(false)
    )
    return () => {
      settled = true
      clearTimeout(timer)
    }
  }, [pendingLanding, landAt, landingAttempt, effectiveId])

  const retryLanding = useCallback(() => {
    setLandingFailed(false)
    setLandingAttempt((n) => n + 1)
  }, [])

  const switchAccount = useCallback(
    async (targetUserId: string, opts?: SwitchAccountOptions): Promise<void> => {
      // Retire the outgoing account's queued sends, replays and transfers
      // BEFORE its credential moves: a message on the wire settles under the
      // account that composed it and nothing new starts. Bounded, so a stalled
      // request cannot hold the switch (see sync/account-fence).
      const retirement = await retireAccountWork()
      try {
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
        adoptAccount(activeUserId, opts?.identity ?? null, opts?.landing ?? "account-home")
        channelRef.current?.postMessage({
          type: "switched",
          activeWorkosUserId: activeUserId,
        } satisfies SwitchedMessage)
      } catch (err) {
        // The account never moved, but its work is already retired: the queue
        // and outbox processors returned and their rows sit pending with
        // nothing left to kick them. Remounting the same account's subtree
        // re-runs the socket/SyncEngine mounts that drain them. Lowering the
        // epoch instead would be wrong twice over — it restarts nothing, and
        // work started after the retirement captured the raised value and
        // would read itself as retired. If a newer retirement landed while
        // this attempt was on the wire (a second switch, another tab's
        // adoption), that one owns the fence and this attempt stays out.
        if (isRetirementCurrent(retirement)) setResumeNonce((n) => n + 1)
        throw err
      }
    },
    [adoptAccount]
  )

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

  // Keyed remount boundary: changing the active account (or bumping the resume
  // nonce after a failed switch) unmounts the old per-account subtree and
  // mounts a fresh one — atomic swap of QueryClient, socket, SyncEngine, and
  // every useState/useRef/useLiveQuery below it. While the handover or a
  // landing is pending the subtree stays unmounted, so the destination's first
  // mount is already under its own storage and at its own URL.
  let body: ReactNode
  if (landingFailed) body = <LandingFailed onRetry={retryLanding} />
  else if (handingOver || pendingLanding) body = <FallbackLoader />
  else body = <ScopedRoot key={`${effectiveId ?? NO_ACCOUNT_KEY}#${resumeNonce}`}>{children}</ScopedRoot>

  return <AccountScopeContext.Provider value={value}>{body}</AccountScopeContext.Provider>
}

function ScopedRoot({ children }: { children: ReactNode }) {
  return <>{children}</>
}
