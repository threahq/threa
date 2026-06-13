import { defaultFeatureFlagValue, isFeatureFlagValue, type FeatureFlags, type FeatureFlagValue } from "@threa/types"

/**
 * Sync-engine v2 cursor rollout stage, driven by the per-user
 * `sync-v2-cursor` feature flag:
 *
 * - "shadow" — track the cursor and page catch-up, log what active mode
 *              WOULD apply, apply nothing. The registry default: production
 *              shadow logs must show the cursor heals correctly (fetched > 0
 *              after disconnects, ~0 on healthy resumes) before "active"
 *              ships.
 * - "off"    — cursor fully inert (runtime kill switch).
 * - "active" — apply catch-up entries through the live handlers and buffer-
 *              and-splice live events while catch-up pages.
 */
export type SyncV2CursorMode = FeatureFlagValue<"sync-v2-cursor">

// The SyncEngine needs its mode BEFORE the workspace bootstrap exists: the
// constructor decides whether the SocketEventGate exists, onConnect pauses
// the gate synchronously before any await, and active mode seeds the cursor
// before the bootstrap fetch — yet the flag value arrives IN the bootstrap.
// This localStorage mirror bridges that gap: every flag delivery (bootstrap
// apply, `feature_flags:updated`) rewrites it, so the next engine
// construction reads the last delivered value synchronously. A first-ever
// boot has no mirror and starts from the registry default; once the
// bootstrap delivers a differing value, the workspace layout recreates the
// engine — one recreation per flag change, not per boot.

function mirrorStorageKey(workspaceId: string): string {
  return `sync-v2-mode:${workspaceId}`
}

/**
 * The last delivered flag value for this workspace, or null when none was
 * mirrored (first boot) or the stored value is no longer declared in the
 * registry (stale mirror from an older deploy).
 */
export function readMirroredSyncV2Mode(workspaceId: string): SyncV2CursorMode | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(mirrorStorageKey(workspaceId))
  } catch {
    // Storage-restricted context: the registry default keeps the engine
    // functional; flag deliveries still apply via engine recreation.
    return null
  }
  return raw !== null && isFeatureFlagValue("sync-v2-cursor", raw) ? (raw as SyncV2CursorMode) : null
}

/** Mirror a delivered flag map's mode for the next engine construction. */
export function mirrorSyncV2Mode(workspaceId: string, featureFlags: FeatureFlags | undefined): void {
  const mode = featureFlags?.["sync-v2-cursor"]
  if (mode === undefined) return
  try {
    localStorage.setItem(mirrorStorageKey(workspaceId), mode)
  } catch {
    // Best-effort: without the mirror the next boot starts from the registry
    // default and converges through engine recreation.
  }
}

/**
 * The mode an engine constructed now should run with: the delivered flag
 * value once the bootstrap is cached, else the mirrored value from the last
 * session, else the registry default.
 */
export function resolveSyncV2Mode(workspaceId: string, knownFlagValue: SyncV2CursorMode | null): SyncV2CursorMode {
  return knownFlagValue ?? readMirroredSyncV2Mode(workspaceId) ?? defaultFeatureFlagValue("sync-v2-cursor")
}
