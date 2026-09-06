/**
 * Synchronous, crash-safe staging area for in-progress composer content.
 *
 * The composer debounces its write to IndexedDB (`use-draft-message.ts`,
 * `DEBOUNCE_MS`). That leaves a window — type, then reload before the debounce
 * fires — where the keystrokes live only in React state and the editor, both of
 * which a reload wipes. Losing user content is the cardinal sin the draft system
 * is built to avoid, so this module closes the window with a write that is
 * durable the instant a keystroke is handled: `localStorage.setItem` is
 * synchronous, so by the time the browser processes a subsequent reload task the
 * value is already on disk.
 *
 * The three persistence layers each have their own write cadence:
 *  - **localStorage (here):** every change, synchronous — the crash-safe buffer.
 *  - **IndexedDB:** debounced (the existing 500ms), the local source of truth.
 *  - **server:** mirrored from IDB through the offline op queue (unchanged).
 *
 * Recovery is content-diff, not timestamp: `reconcileStagedDrafts`
 * (`sync/draft-sync.ts`) compares a staged entry against the IDB draft and only
 * recovers what genuinely differs, deferring cross-device conflicts to the
 * existing `version`/split machinery. Comparing wall-clock timestamps across
 * devices is unsafe (a roamed draft carries another device's clock), so we never
 * do; `sync/draft-sync.test.ts` pins the recovery rules.
 *
 * **Plaintext only (E2EE-4).** An encrypted draft is sealed before it ever
 * touches disk; staging it would write plaintext at rest. So E2E scopes never
 * stage here — the caller gates on encryption — and the reconcile refuses to
 * apply a staged entry over a sealed row. The reload-loss window stays open for
 * E2E drafts, which is the correct trade: there is no synchronous seal.
 */

import type { JSONContent } from "@threahq/types"
import { isEmptyContent } from "@/lib/prosemirror-utils"
import { getPerfCapture } from "@/lib/perf/capture"

const PREFIX = "threa:draft-stage:"

/**
 * Skip staging a serialized payload longer than this (measured in `string.length`,
 * i.e. UTF-16 code units — localStorage stores UTF-16, so the on-disk cost is
 * roughly twice this in bytes, ~512KB). A pathological paste (a whole document
 * into the composer) would make the synchronous per-keystroke write janky and eat
 * into the localStorage quota; the debounced IDB write still persists it, so the
 * only cost of skipping is the reload-loss window for that one outsized draft.
 */
const MAX_STAGED_CHARS = 256 * 1024

export interface StagedDraft {
  scope: string
  contentJson: JSONContent
  /** Authoring-device clock (ms). Kept for ordering/debugging only — recovery is content-diff, never a cross-device timestamp compare. */
  clientUpdatedAt: number
}

function workspacePrefix(workspaceId: string): string {
  return `${PREFIX}${workspaceId}:`
}

function keyFor(workspaceId: string, scope: string): string {
  return `${workspacePrefix(workspaceId)}${scope}`
}

function storageAvailable(): boolean {
  return typeof localStorage !== "undefined"
}

/**
 * Synchronously stage the composer's current plaintext content for `scope`.
 * Overwrites the previous staged value (the latest keystroke wins). Empty
 * content clears the key instead of staging it — an emptied editor must not
 * resurrect on reload, and deletion propagation is the debounce's job, not the
 * buffer's. Best-effort: a quota/private-mode failure is swallowed because the
 * debounced IDB write still stands.
 */
export function stageDraftContent(workspaceId: string, scope: string, contentJson: JSONContent): void {
  if (!storageAvailable()) return
  const capture = getPerfCapture()
  const stopStaging = capture.time("draft.staging")
  try {
    if (isEmptyContent(contentJson)) {
      localStorage.removeItem(keyFor(workspaceId, scope))
      return
    }
    const raw = JSON.stringify({ contentJson, clientUpdatedAt: Date.now() })
    if (raw.length > MAX_STAGED_CHARS) {
      // Too large to stage cheaply — drop any prior buffer and let the debounce
      // carry it to IDB. Leaving a stale smaller entry would recover the wrong body.
      localStorage.removeItem(keyFor(workspaceId, scope))
      return
    }
    localStorage.setItem(keyFor(workspaceId, scope), raw)
    capture.mark("draft.stagedChars", raw.length)
  } catch {
    // Quota exceeded / storage disabled — never interrupt typing. The local
    // copy reaches IDB on the debounce regardless.
  } finally {
    stopStaging()
  }
}

/** Read the staged plaintext entry for `scope`, or null when absent/corrupt. */
export function readStagedDraft(workspaceId: string, scope: string): StagedDraft | null {
  if (!storageAvailable()) return null
  try {
    const raw = localStorage.getItem(keyFor(workspaceId, scope))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { contentJson?: unknown; clientUpdatedAt?: unknown }
    if (!parsed || typeof parsed !== "object" || !parsed.contentJson) return null
    return {
      scope,
      contentJson: parsed.contentJson as JSONContent,
      clientUpdatedAt: typeof parsed.clientUpdatedAt === "number" ? parsed.clientUpdatedAt : Date.now(),
    }
  } catch {
    return null
  }
}

/** Remove the staged entry for `scope`. Idempotent; safe when absent. */
export function clearStagedDraft(workspaceId: string, scope: string): void {
  if (!storageAvailable()) return
  try {
    localStorage.removeItem(keyFor(workspaceId, scope))
  } catch {
    // Ignore — a failed clear at worst leaves a stale buffer the next reconcile drops.
  }
}

/** Every staged entry for a workspace (used by the startup reconcile). */
export function listStagedDrafts(workspaceId: string): StagedDraft[] {
  if (!storageAvailable()) return []
  const prefix = workspacePrefix(workspaceId)
  const out: StagedDraft[] = []
  try {
    // Snapshot the keys before reading. `localStorage.length`/`key(i)` index a
    // LIVE store, so another tab writing/removing a key mid-iteration would shift
    // indices and silently skip an entry; collect first, then read each (a
    // since-deleted key reads back null and is skipped).
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) {
      const entry = readStagedDraft(workspaceId, key.slice(prefix.length))
      if (entry) out.push(entry)
    }
  } catch {
    return out
  }
  return out
}
