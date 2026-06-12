// =============================================================================
// Feature Flags
// Per-user rollout switches managed from the backoffice (control plane) and
// fanned out to regional backends, where they ride WorkspaceBootstrap and a
// user-scoped socket event so both sides of the stack resolve the same value.
//
// Flags are TEMPORARY by design: the registry below is the only source of
// truth for which keys exist. Deleting a key here makes any lingering DB
// override rows inert everywhere (they are filtered through the registry at
// read time), so removing a finished flag is a one-line change.
// =============================================================================

/**
 * Every live feature flag. Add a key while rolling a feature out; delete it
 * the moment the rollout is done. A flag that survives long here is a smell.
 */
export const FEATURE_FLAG_KEYS = [
  /** Demo flag for verifying the flag pipeline end to end. Safe to toggle anywhere. */
  "demo-banner",
] as const

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number]

/** Fully resolved flag map for one user in one workspace (wire format). */
export type FeatureFlags = Record<FeatureFlagKey, boolean>

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return (FEATURE_FLAG_KEYS as readonly string[]).includes(value)
}

/** Flags are off unless an override turns them on. */
export function defaultFeatureFlags(): FeatureFlags {
  return Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, false])) as FeatureFlags
}

/**
 * Layer stored overrides onto defaults, dropping overrides for keys no longer
 * in the registry — this is what makes deleting a flag from
 * {@link FEATURE_FLAG_KEYS} sufficient to retire it.
 */
export function resolveFeatureFlags(overrides: Iterable<{ flagKey: string; enabled: boolean }>): FeatureFlags {
  const flags = defaultFeatureFlags()
  for (const { flagKey, enabled } of overrides) {
    if (isFeatureFlagKey(flagKey)) {
      flags[flagKey] = enabled
    }
  }
  return flags
}
