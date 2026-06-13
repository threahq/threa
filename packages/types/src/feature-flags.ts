// =============================================================================
// Feature Flags
// Per-user rollout switches managed from the backoffice (control plane) and
// fanned out to regional backends, where they ride WorkspaceBootstrap and a
// user-scoped socket event so both sides of the stack resolve the same value.
//
// Flags are enum-valued, not boolean: each flag declares its allowed values
// and the FIRST value is the default. A plain on/off flag is just the
// two-value case (["off", "on"]); staged rollouts get richer variants
// (e.g. ["off", "shadow", "active"]) without inventing flag combinations.
//
// Flags are TEMPORARY by design: the registry below is the only source of
// truth for which keys and values exist. Deleting a key here makes any
// lingering DB override rows inert everywhere (they are filtered through the
// registry at read time), so removing a finished flag is a one-line change.
// =============================================================================

/**
 * Every live feature flag, mapping key → allowed values. The first value is
 * the default. Add a flag while rolling a feature out; delete it the moment
 * the rollout is done. A flag that survives long here is a smell.
 */
export const FEATURE_FLAGS = {
  /**
   * Sync-engine v2 cursor rollout stage: "active" (the default) applies
   * catch-up entries through the live handlers, "off" is the runtime kill
   * switch, "shadow" tracks the workspace sync-log cursor and only logs what
   * active mode would apply. The mode is fixed per SyncEngine lifetime — see
   * apps/frontend/src/sync/sync-v2-mode.ts.
   */
  "sync-v2-cursor": ["active", "off", "shadow"],
} as const satisfies Record<string, readonly [string, ...string[]]>

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS

/** The allowed values for one flag (or any flag, when unparameterized). */
export type FeatureFlagValue<K extends FeatureFlagKey = FeatureFlagKey> = (typeof FEATURE_FLAGS)[K][number]

/** Fully resolved flag map for one user in one workspace (wire format). */
export type FeatureFlags = { [K in FeatureFlagKey]: FeatureFlagValue<K> }

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[]

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return value in FEATURE_FLAGS
}

/** Whether `value` is one of the declared values for `key`. */
export function isFeatureFlagValue(key: FeatureFlagKey, value: string): boolean {
  return (FEATURE_FLAGS[key] as readonly string[]).includes(value)
}

/** The default for a flag is the first declared value. */
export function defaultFeatureFlagValue<K extends FeatureFlagKey>(key: K): FeatureFlagValue<K> {
  return FEATURE_FLAGS[key][0] as FeatureFlagValue<K>
}

/** Every flag at its default (first declared) value. */
export function defaultFeatureFlags(): FeatureFlags {
  return Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, defaultFeatureFlagValue(key)])) as FeatureFlags
}

/**
 * Layer stored overrides onto defaults, dropping overrides whose key is no
 * longer in the registry or whose value is no longer declared for that key —
 * this is what makes deleting a flag (or renaming a value) in
 * {@link FEATURE_FLAGS} sufficient to retire it.
 */
export function resolveFeatureFlags(overrides: Iterable<{ flagKey: string; value: string }>): FeatureFlags {
  const flags = defaultFeatureFlags()
  for (const { flagKey, value } of overrides) {
    if (isFeatureFlagKey(flagKey) && isFeatureFlagValue(flagKey, value)) {
      flags[flagKey] = value as FeatureFlags[typeof flagKey]
    }
  }
  return flags
}
