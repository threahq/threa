import { useCallback, useEffect, useRef } from "react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import { useLiveQuery } from "dexie-react-hooks"
import { db } from "@/db"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import {
  RESTORE_REFUSAL_MESSAGE,
  type DraftRestoreRefusal,
  type DraftRestoreResult,
} from "@/lib/drafts/restore-refusal"
import { enqueueDraftUpsert, migrateLocalDraftScope } from "@/sync/draft-sync"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { restoreStashedDraftToComposer, stashLoadedDraft } from "./use-draft-message"
import { setComposerTarget } from "./use-composer-target"
import {
  useStashedDrafts,
  type CachedDraft,
  type StashedDraftOrigin,
  type StashedDraftSource,
} from "./use-stashed-drafts"
import type { DraftComposerState } from "./use-draft-composer"

/** What restoring a pile row into a host does. See {@link planDraftRestore}. */
export type DraftRestorePlan =
  | { action: "same-scope" }
  | { action: "adopt"; targetHost: string; targetScope: string }
  | { action: "refuse"; reason: DraftRestoreRefusal }
  | { action: "move"; fromScope: string; toScope: string }

/**
 * Adopt or move — the one decision the shared pile turns on, taken from the
 * row's structured origin rather than from re-parsed scope strings (INV-35).
 *
 * - **Same scope** — today's pointer move, untouched.
 * - **Adopt** — the host can point its composer target at a scope it can also
 *   display, so the draft keeps its filing and the row NEVER moves: a
 *   conversation reply or a branch reply (the strip then reads "Replying in
 *   <C>" and the send files into C through the directive that already exists),
 *   or the host's own scope while it is armed elsewhere (targeting it is a
 *   disarm). The adoptable set is exactly what `message-input` derives a
 *   `targetConversationId` from — `board:reply:` and `board:branch-reply:`; a
 *   source the host can hold must never be moved, because moving rewrites the
 *   row's scope and destroys its filing with no undo.
 * - **Move** — everything else. A board conversation composer cannot be
 *   un-armed and a thread panel cannot display a conversation strip, and no
 *   host can target a `board:subtopic:` or `thread:` scope at all, so the only
 *   way to restore there is to make the draft the host's own.
 *
 * `targetHost` is the `composerTarget` key of a host that can retarget itself
 * (only the timeline's top-level composer); `null` for hosts that can't.
 */
export function planDraftRestore(input: {
  hostScope: string
  targetHost: string | null
  draftScope: string
  draftSource: StashedDraftSource | null
}): DraftRestorePlan {
  const { hostScope, targetHost, draftScope, draftSource } = input
  if (draftScope === hostScope) return { action: "same-scope" }
  // A branch reply has no host outside its own composer that can both hold it and
  // SEND it. Adopting looks right — the timeline can hold the target and render
  // the strip — but a branch conversation lives in a thread by construction, so
  // the send guard always finds it not-live-here and hands off to a panel that
  // opens `board:reply:<B>`, not the branch tail: the message is never sent and
  // the draft is stranded. Moving is worse: it rewrites the scope and destroys the
  // filing. So neither, and say so — the row stays visible and the user is told
  // where it lives.
  if (draftSource?.kind === "branch") return { action: "refuse", reason: "branch-elsewhere" }
  const adoptableSource = draftSource?.kind === "conversation"
  if (targetHost && (adoptableSource || draftScope === targetHost)) {
    return { action: "adopt", targetHost, targetScope: draftScope }
  }
  return { action: "move", fromScope: draftScope, toScope: hostScope }
}

/** Every scope holding a device-local pointer at this draft. */
async function loadedScopesForDraft(draftId: string): Promise<string[]> {
  const pointers = await db.composerLoaded.toArray()
  return pointers.filter((row) => row.draftId === draftId).map((row) => row.scope)
}

/**
 * What a host tells the pile about itself beyond its scope. Only the timeline's
 * top-level composer has one; a thread panel and a board composer restore by
 * moving the row instead. `disarmTarget` comes with `targetHost` rather than
 * being derived here: clearing the target is only half of a disarm — the host's
 * own gesture latch has to go with it, or a later adopt reads as a fresh
 * "reply in conversation" gesture and redirects to the panel.
 */
export interface StashComposerHost {
  /** The `composerTarget` key this composer can point at another scope. */
  targetHost: string
  /** The host's own disarm: clears the target AND its gesture latch. */
  disarmTarget: () => Promise<void>
}

function refuse(reason: DraftRestoreRefusal, message: string): DraftRestoreResult {
  console.error(`[stash] ${message}`)
  return { ok: false, reason }
}

export interface UseStashComposerResult {
  /** The landing-site-wide pile the picker renders, newest first within each tier. */
  drafts: CachedDraft[]
  /** This scope's own rows — what the `?stash=` deep link may claim. */
  claimableDrafts: CachedDraft[]
  /** Where each pile row came from, keyed by draft id (structured; the caller formats). */
  originByDraftId: Map<string, StashedDraftOrigin>
  /** Tell the pile whether the picker is open, so membership latches while it is. */
  setPileOpen: (open: boolean) => void
  /** Snapshot the current composer content into the stash, clear the editor. Empty composer → silent no-op. */
  handleStashDraft: () => Promise<void>
  /** Swap: stash current content first (if any), then bring the chosen pile row here — adopting or moving it as {@link planDraftRestore} decides. Refusals come back as data for the caller to surface. */
  handleRestoreStashed: (id: string) => Promise<DraftRestoreResult>
  /** Delete a stashed row without restoring. */
  handleDeleteStashed: (id: string) => Promise<void>
}

/**
 * Binds the stashed-drafts pile (`useStashedDrafts`) to a `DraftComposerState`
 * so the two composer hosts (`MessageInput` and `StreamPanel`) don't each carry
 * their own copy of the stash / restore / delete callbacks. It also owns the
 * `?stash=<id>` URL auto-restore.
 *
 * Stash and restore are **pointer moves**, not content snapshots — exactly "a
 * stashed draft is a draft without the active state". Stashing flushes the live
 * editor into its row (sealed for E2E) and detaches the loaded pointer so the row
 * becomes a stash entry; restoring points the scope at the chosen row and lets
 * the composer re-read (decrypting on the way in for E2E) the newly-loaded body.
 * Because nothing is copied, an encrypted draft rides the identical path with no
 * plaintext ever leaving memory (E2EE-4) — so the pile works the same for
 * plaintext and E2E streams with no special-casing here.
 *
 * A row from another scope is still no copy: it is either adopted (the host
 * points at the row's scope, the row stays put) or moved (same row, same id,
 * new `scope`). See {@link planDraftRestore}.
 */
/**
 * The draft row named by the URL's `?stash=` param, for surfaces that must
 * decide whether a deep-linked restore is theirs to host (e.g. a board card /
 * conversation panel auto-opening a branch-tail composer). A Dexie point query
 * on the one id — it re-fires only when that row changes, so it's cheap enough
 * to mount per board card. Returns null when there is no param, the row hasn't
 * synced yet, or it belongs to another workspace.
 */
export function useStashParamDraftRow(
  workspaceId: string
): { draftId: string; scope: string; isLoadedForScope: boolean } | null {
  const [searchParams] = useSearchParams()
  const draftId = searchParams.get("stash")
  // The pointer is read inside the SAME point query as the row, not through the
  // workspace-wide composer-loaded store: this hook mounts per board card, and a
  // store subscription would re-render every one of them whenever any composer
  // anywhere checks a draft in or out.
  const found = useLiveQuery(async () => {
    if (!draftId) return undefined
    const draft = await db.drafts.get(draftId)
    if (!draft) return undefined
    const pointer = await db.composerLoaded.get(draft.scope)
    return { draft, isLoadedForScope: pointer?.draftId === draftId }
  }, [draftId])
  if (!draftId || !found || found.draft.workspaceId !== workspaceId) return null
  // Already checked out into its own scope's composer: a deep link to it has
  // nothing to restore, so a consumer must not treat it as a pending one.
  return { draftId, scope: found.draft.scope, isLoadedForScope: found.isLoadedForScope }
}

export function useStashComposer(
  composer: DraftComposerState,
  workspaceId: string,
  scope: string | undefined,
  host?: StashComposerHost
): UseStashComposerResult {
  const stashedDrafts = useStashedDrafts(workspaceId, scope)
  const syncEngine = useOptionalSyncEngine()
  const targetHost = host?.targetHost ?? null
  const disarmTarget = host?.disarmTarget ?? null

  const handleStashDraft = useCallback(async () => {
    if (!scope) return
    // Nothing worth stashing → silent no-op (parity with the picker's disabled
    // button and the product brief). Attachments alone count as content.
    const hasContent = !isEmptyContent(composer.content)
    const hasAttachments = composer.uploadedIds.length > 0
    if (!hasContent && !hasAttachments) return

    // Flush the live editor into its row first (sealed for E2E, E2EE-4) so the
    // stash entry carries exactly what the user was typing, then detach it. The
    // flush never deletes (it no-ops on empty), so it can't destroy the draft.
    await composer.flushDraft()
    const stashedId = await stashLoadedDraft(workspaceId, scope)
    if (!stashedId) return
    // Re-init the (now draft-less) composer so the editor blanks out.
    composer.markNeedsRehydrate()
  }, [composer, workspaceId, scope])

  const { canHostForeignDraft, describeScope } = stashedDrafts

  /**
   * Bring pile row `id` into this host. Everything is revalidated HERE, against
   * IDB, not against the pile computed a render ago: by the time the user clicks,
   * the row may have been deleted or checked out elsewhere and the host may have
   * resolved encrypted or archived. On any failure nothing happens at all — no
   * partial move, both drafts intact — and the reason comes back to the caller,
   * which owes the user a message: the picker closes and the caret lands in the
   * composer either way, so a silent refusal looks exactly like a success
   * (INV-11, INV-63).
   */
  const restoreDraftHere = useCallback(
    async (id: string): Promise<DraftRestoreResult> => {
      if (!scope) return refuse("host-ineligible", `refusing restore of ${id}: host has no scope yet`)
      const row = await db.drafts.get(id)
      if (!row || row.workspaceId !== workspaceId) {
        return refuse("missing", `refusing restore of missing draft ${id}`)
      }
      // Checked out anywhere on this device — including under its own scope — is
      // not restorable: two scopes holding one row make their debounced saves
      // fight over its `scope` and body.
      const checkedOut = await loadedScopesForDraft(id)
      if (checkedOut.length > 0) {
        return refuse("checked-out", `refusing restore of ${id}: checked out in ${checkedOut.join(", ")}`)
      }

      const plan = planDraftRestore({
        hostScope: scope,
        targetHost,
        draftScope: row.scope,
        draftSource: describeScope(row.scope),
      })
      if (plan.action === "refuse") {
        return refuse(plan.reason, `refusing restore of ${id} into ${scope}: ${plan.reason}`)
      }
      // Leaving the row's own scope needs a host that can hold it: an encrypted
      // or archived home means the pile should never have offered it, and for an
      // adopt a late `e2eEnabled` resolve would let `purgePlaintextScopeDrafts`
      // delete the draft we just targeted.
      if (plan.action !== "same-scope" && !canHostForeignDraft()) {
        return refuse("host-ineligible", `refusing restore of ${id} into ${scope}: host is not eligible`)
      }

      // Swap semantics: flush whatever the composer holds into its row first so
      // switching drafts never silently destroys work — it stays as a stash entry
      // once the pointer moves off it. `flushDraft` only persists a non-empty
      // editor, so a restore fired while the composer is still mid-hydration
      // (transiently empty) can NEVER delete the currently-loaded draft. A thrown
      // flush (e.g. IDB quota, or a seal that raced a lock) is swallowed: losing a
      // recent auto-save is a smaller harm than aborting the deliberate restore.
      try {
        await composer.flushDraft()
      } catch (err) {
        console.error("Failed to flush current content before restoring", err)
      }

      if (plan.action === "adopt") {
        // The pre-checks proved the RESTORED ROW is checked out nowhere; they say
        // nothing about the scope we are about to point at. A conversation can
        // hold one draft in its own composer and have another stashed, and that
        // stashed one is in this pile. Repointing the target scope would leave
        // that composer rendering its old body against our draft's id — its
        // loaded id changes value rather than going null, so nothing blanks or
        // rehydrates it — and its next debounced save would write that body into
        // the row we just adopted. We cannot flush an editor we do not own, so
        // refuse and let the user deal with it where it lives.
        const targetPointer = await db.composerLoaded.get(plan.targetScope)
        if (targetPointer?.draftId && targetPointer.draftId !== id) {
          return refuse("target-busy", `refusing adopt of ${id}: ${plan.targetScope} holds ${targetPointer.draftId}`)
        }
        // The row stays exactly where it is — it keeps its filing, which is the
        // whole point. Check it out under its OWN scope first, then point the
        // host at it, so the composer never renders the target scope for a frame
        // with no draft loaded under it. Targeting the host's own scope IS the
        // disarm, so it clears rather than stores.
        await restoreStashedDraftToComposer(workspaceId, plan.targetScope, id)
        // Through the host's own disarm, never a bare `clearComposerTarget`: the
        // gesture latch has to be cleared with the target or a later adopt reads
        // as a fresh gesture and redirects to the panel, wiping the target the
        // adopt just set.
        if (plan.targetScope === plan.targetHost) {
          if (!disarmTarget) throw new Error(`[stash] host ${plan.targetHost} can retarget but has no disarm`)
          await disarmTarget()
        } else await setComposerTarget(workspaceId, plan.targetHost, plan.targetScope)
        composer.markNeedsRehydrate()
        return { ok: true }
      }

      if (plan.action === "move") {
        // Row-preserving: same id, same `baseVersion`, `scope` rewritten. NOT
        // `relocateLoadedDraft` (it rebuilds the row through `upsertLoadedDraft`
        // with no seal context, writing plaintext at rest on an encrypted stream)
        // and NOT a plain coalescing enqueue (a push snapshotted before the move
        // may be in flight with its claim not yet visible; coalescing onto it
        // loses the scope change server-side forever). Move + enqueue share one
        // transaction so the re-scoped row is never visible without its dirty bit.
        const moved = await db.transaction("rw", db.drafts, db.composerLoaded, db.pendingOperations, async () => {
          const live = await db.drafts.get(id)
          if (!live || live.scope !== plan.fromScope) return false
          await migrateLocalDraftScope(workspaceId, plan.fromScope, { ...live, scope: plan.toScope })
          await enqueueDraftUpsert(workspaceId, id, { forceNewOp: true })
          return true
        })
        if (!moved) {
          return refuse("raced", `draft ${id} moved out of ${plan.fromScope} before its restore could run`)
        }
        syncEngine?.kickOperationQueue()
      }

      // The host's pointer takes the restored row. Whatever it held is detached
      // by that same write and becomes a stash entry — a scope points at exactly
      // one draft, so the swap never clobbers (it was already flushed above).
      await restoreStashedDraftToComposer(workspaceId, scope, id)
      // Re-read the newly-pointed draft into the editor (decrypting it for E2E).
      composer.markNeedsRehydrate()
      return { ok: true }
    },
    [composer, workspaceId, scope, targetHost, disarmTarget, canHostForeignDraft, describeScope, syncEngine]
  )

  const handleRestoreStashed = restoreDraftHere

  const handleDeleteStashed = useCallback(
    async (id: string) => {
      await stashedDrafts.deleteStashedDraft(id)
    },
    [stashedDrafts]
  )

  // Auto-restore when the URL carries `?stash=<id>` — how the /drafts explorer
  // deep-links to a specific snapshot. The dedup ref prevents the same id firing
  // twice within one mount if React re-runs the effect, and the param is stripped
  // only after the restore resolves so a thrown error doesn't silently eat the
  // deep link (a refresh can retry).
  const [searchParams, setSearchParams] = useSearchParams()
  const pendingStashRestoreRef = useRef<string | null>(null)
  useEffect(() => {
    const stashId = searchParams.get("stash")
    if (!stashId || !scope || !composer.isLoaded) return
    // Two gates, both load-bearing. The row must belong to THIS scope
    // (`claimableDrafts`, not the landing-site-wide pile): restoring a foreign id
    // would point this scope's loaded draft at another scope's row, splitting one
    // draft across two composers. And this composer must hold the scope's claim —
    // a board card and the conversation panel's footer mount the same scope, so
    // membership alone let both restore. A non-claimant skips WITHOUT stripping,
    // leaving the param for the claimant.
    if (!composer.isStashClaimant) return
    if (!stashedDrafts.claimableDrafts.some((draft) => draft.id === stashId)) return
    if (pendingStashRestoreRef.current === stashId) return

    pendingStashRestoreRef.current = stashId

    handleRestoreStashed(stashId).then(
      (result) => {
        // A refusal is not an error, so this branch runs for one too. Stripping
        // here would swallow exactly what the picker was just fixed to surface:
        // the user arrives from /drafts, the composer is empty, the URL is clean
        // and nothing says why. Keep the param and tell them (INV-63).
        if (!result.ok) {
          toast.error(RESTORE_REFUSAL_MESSAGE[result.reason])
          return
        }
        const nextParams = new URLSearchParams(searchParams)
        nextParams.delete("stash")
        setSearchParams(nextParams, { replace: true })
      },
      (err) => {
        // Keep the param so a refresh can retry; dedup ref still prevents
        // a loop within this mount.
        console.error("Failed to auto-restore stashed draft from URL", err)
      }
    )
  }, [
    searchParams,
    setSearchParams,
    scope,
    composer.isLoaded,
    composer.isStashClaimant,
    stashedDrafts.claimableDrafts,
    handleRestoreStashed,
  ])

  return {
    drafts: stashedDrafts.drafts,
    claimableDrafts: stashedDrafts.claimableDrafts,
    originByDraftId: stashedDrafts.originByDraftId,
    setPileOpen: stashedDrafts.setPileOpen,
    handleStashDraft,
    handleRestoreStashed,
    handleDeleteStashed,
  }
}
