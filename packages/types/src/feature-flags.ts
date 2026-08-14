// Feature Flags: rollout switches managed from the backoffice (control plane) and
// fanned out to regional backends, where they ride WorkspaceBootstrap and a
// socket event so both sides of the stack resolve the same value.
//
// Flags are enum-valued, not boolean: each flag declares its allowed values and
// an explicit `default`. A plain on/off flag is just the two-value case
// (["off", "on"]); staged rollouts get richer variants (e.g.
// ["off", "shadow", "active"]) without inventing flag combinations. The default
// is spelled out rather than inferred from value order — an unset flag's
// resolved value should never depend on which element happens to be first.
//
// Flags are SCOPED: each declares which subjects may carry an override —
// ["workspace"], ["user"], or both. Resolution layers registry default →
// workspace override → user override, but only across the scopes a flag
// declares, so a stored workspace row for a user-only flag is inert. Narrowing
// a flag's scopes is therefore as safe as deleting it: no migration, the rows
// simply stop being read.
//
// Flags are TEMPORARY by design: the registry below is the only source of
// truth for which keys, values, and scopes exist. Deleting a key here makes any
// lingering DB override rows inert everywhere (they are filtered through the
// registry at read time), so removing a finished flag is a one-line change.

/** The subjects an override may be attached to — the single source for both the type and runtime validation. */
export const FEATURE_FLAG_SCOPES = ["workspace", "user"] as const

/** Which subject an override may be attached to. */
export type FeatureFlagScope = (typeof FEATURE_FLAG_SCOPES)[number]

/** One registry entry: allowed values, the explicit default, and the scopes that may override it. */
export interface FeatureFlagDefinition {
  readonly values: readonly [string, ...string[]]
  readonly scopes: readonly [FeatureFlagScope, ...FeatureFlagScope[]]
  readonly default: string
}

export type FeatureFlagRegistry = Record<string, FeatureFlagDefinition>

/**
 * Declare one flag, enforcing at compile time that `default` is one of `values`
 * while preserving the literal value/scope types the registry derives from —
 * an annotated `FeatureFlagDefinition` would widen `values` to `string[]` and
 * lose {@link FeatureFlagValue}'s narrowing.
 */
export function defineFlag<
  const V extends readonly [string, ...string[]],
  const S extends readonly [FeatureFlagScope, ...FeatureFlagScope[]],
>(def: { values: V; scopes: S; default: V[number] }): { values: V; scopes: S; default: V[number] } {
  return def
}

/**
 * Every live feature flag. Add a flag while rolling a feature out; delete it
 * the moment the rollout is done. A flag that survives long here is a smell.
 */
export const FEATURE_FLAGS = {
  calls: defineFlag({ values: ["off", "on"], scopes: ["workspace"], default: "on" }),
  composeTraces: defineFlag({ values: ["off", "capture"], scopes: ["workspace"], default: "off" }),
  // Availability only: "available" offers the Diagnostics settings toggle. The
  // user's own opt-in preference is the consent, and the upload path re-checks
  // both server-side.
  perfDiagnostics: defineFlag({ values: ["off", "available"], scopes: ["workspace", "user"], default: "off" }),
} as const satisfies FeatureFlagRegistry

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS

/** The allowed values for one flag (or any flag, when unparameterized). */
export type FeatureFlagValue<K extends FeatureFlagKey = FeatureFlagKey> = (typeof FEATURE_FLAGS)[K]["values"][number]

/** Fully resolved flag map for one user in one workspace (wire format). */
export type FeatureFlags = { [K in FeatureFlagKey]: FeatureFlagValue<K> }

/** Raw stored overrides per scope, before resolution (wire format). */
export interface FeatureFlagLayers {
  workspace: Record<string, string>
  user: Record<string, string>
}

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[]

// Widened view of FEATURE_FLAGS for runtime lookups: the literal type is what derives
// FeatureFlagKey/FeatureFlagValue, but indexing it resolves to `never` while the
// registry is empty, which no property access typechecks against.
export const FEATURE_FLAG_DEFINITIONS: FeatureFlagRegistry = FEATURE_FLAGS

// Every registry lookup goes through Object.hasOwn, never `in` or a bare index:
// keys arrive from HTTP bodies and stored rows, and "constructor"/"toString"
// resolve up the prototype chain to non-definitions that then throw on `.values`.
export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return Object.hasOwn(FEATURE_FLAG_DEFINITIONS, value)
}

/** Whether `value` is one of the declared values for `key`. */
export function isFeatureFlagValue(key: FeatureFlagKey, value: string): boolean {
  return Object.hasOwn(FEATURE_FLAG_DEFINITIONS, key) && FEATURE_FLAG_DEFINITIONS[key].values.includes(value)
}

/** Whether `key` accepts an override stored against `scope`. */
export function flagAllowsScope(key: FeatureFlagKey, scope: FeatureFlagScope): boolean {
  return registryAllowsScope(FEATURE_FLAG_DEFINITIONS, key, scope)
}

/** A flag's explicit default, resolved when no override applies. */
export function defaultFeatureFlagValue<K extends FeatureFlagKey>(key: K): FeatureFlagValue<K> {
  return FEATURE_FLAG_DEFINITIONS[key].default as FeatureFlagValue<K>
}

/** Every flag at its declared default. */
export function defaultFeatureFlags(): FeatureFlags {
  return Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, defaultFeatureFlagValue(key)])) as FeatureFlags
}

/**
 * Layer stored overrides onto defaults: workspace first, then user, so a user
 * override wins. An override is dropped when its key is no longer in the
 * registry, its value is no longer declared for that key, or the flag does not
 * declare the scope it was stored against — this is what makes editing
 * {@link FEATURE_FLAGS} sufficient to retire a flag or narrow its scopes.
 */
export function resolveFeatureFlags(layers: FeatureFlagLayers): FeatureFlags {
  return resolveAgainstRegistry(FEATURE_FLAG_DEFINITIONS, layers) as FeatureFlags
}

// The two functions below take the registry as a parameter so the scope and layering
// rules stay testable: FEATURE_FLAGS is empty between rollouts, and an empty
// registry resolves every input to {}.

// Pre-#1455 clients stored `featureFlags` as the flat resolved map (typically
// `{}`); read as layers, `layers.workspace`/`layers.user` are undefined and the
// resolver throws on Object.entries — killing the first render until the row is
// rewritten. Coerce any value missing a layer record to well-formed layers
// (dropping the unlayerable flat keys — the next bootstrap re-persists the real
// shape); a well-formed value passes through by reference so downstream memos hold.
export function coerceLayers(layers: FeatureFlagLayers | null): FeatureFlagLayers | null {
  if (!layers) return null
  if (isLayerRecord(layers.workspace) && isLayerRecord(layers.user)) return layers
  return {
    workspace: isLayerRecord(layers.workspace) ? layers.workspace : {},
    user: isLayerRecord(layers.user) ? layers.user : {},
  }
}

function isLayerRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === "string")
}

export function registryAllowsScope(registry: FeatureFlagRegistry, key: string, scope: FeatureFlagScope): boolean {
  return Object.hasOwn(registry, key) && registry[key].scopes.includes(scope)
}

export function resolveAgainstRegistry(
  registry: FeatureFlagRegistry,
  layers: FeatureFlagLayers
): Record<string, string> {
  const flags: Record<string, string> = {}
  for (const [key, definition] of Object.entries(registry)) {
    flags[key] = definition.default
  }
  applyLayer(registry, flags, "workspace", layers.workspace)
  applyLayer(registry, flags, "user", layers.user)
  return flags
}

function applyLayer(
  registry: FeatureFlagRegistry,
  flags: Record<string, string>,
  scope: FeatureFlagScope,
  overrides: Record<string, string>
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(registry, key)) continue
    const definition = registry[key]
    if (!definition.scopes.includes(scope)) continue
    if (!definition.values.includes(value)) continue
    flags[key] = value
  }
}
