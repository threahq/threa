/**
 * Pure helpers for staging PR lifecycle management, extracted so the orphan
 * classification can be unit-tested without touching Railway / Cloudflare /
 * Postgres. `staging-pr.ts` imports these; keep this module side-effect free.
 */

/** Resource names for one PR, derived from its number. */
export interface StagingResourceNames {
  readonly pr: number
  /** Backend database, e.g. `pr_228`. */
  readonly prDbName: string
  /** Control-plane database, e.g. `pr_228_cp`. */
  readonly prCpDbName: string
  /** KV `__regions_config__` key, e.g. `pr-228`. */
  readonly regionName: string
  /** Railway service, e.g. `pr-228-backend`. */
  readonly serviceName: string
  /** Frontend hostname, e.g. `pr-228-staging.threa.io`. */
  readonly prHostname: string
}

/**
 * Single source of truth for per-PR resource names. A pure function of the PR
 * number so teardown can run for many numbers in one process (reconcile).
 */
export function stagingResourceNames(prNumber: number): StagingResourceNames {
  return {
    pr: prNumber,
    prDbName: `pr_${prNumber}`,
    prCpDbName: `pr_${prNumber}_cp`,
    regionName: `pr-${prNumber}`,
    serviceName: `pr-${prNumber}-backend`,
    prHostname: `pr-${prNumber}-staging.threa.io`,
  }
}

// Strict, end-anchored patterns are the safety boundary: only names matching
// these can ever yield a teardown candidate. Live Railway service names are
// exact (`pr-228-backend`); a DELETED service is renamed with a UUID suffix
// (`pr-228-backend-47675d47-...`), which the `-backend$` anchor rejects. The
// shared infra — `backend`, `control-plane`, `Postgres`, `staging_main`,
// `staging_main_cp`, `railway`, `postgres`, `template0/1` — matches none of
// these, so it is structurally unreachable, not merely skipped.
//
// The flip side: the whole `pr_<digits>` / `pr-<digits>` namespace is
// reserved-and-reaped. A hand-made `pr_9999` experiment DB WILL be swept as an
// orphan on the next nightly run — name experiments anything else.
export const STAGING_SERVICE_RE = /^pr-(\d+)-backend$/
export const STAGING_DB_RE = /^pr_(\d+)(_cp)?$/
export const STAGING_KV_REGION_RE = /^pr-(\d+)$/

/**
 * Teardown re-derives resource names from the parsed number, so a discovered
 * name must round-trip exactly (`pr_0123` → 123 → `pr_123` would drop the
 * wrong DB and leak the discovered one). Reject non-canonical digit strings.
 */
function canonicalPrNumber(digits: string): number | null {
  const pr = Number(digits)
  return String(pr) === digits ? pr : null
}

export interface StagingReconcileInput {
  /** All Railway service names in the project. */
  readonly serviceNames: readonly string[]
  /** All `datname` values from `pg_database`. */
  readonly dbNames: readonly string[]
  /** All keys present in the `__regions_config__` KV blob. */
  readonly kvRegionKeys: readonly string[]
  /** PR numbers that are open AND carry the `staging` label. */
  readonly openLabeledPrNumbers: readonly number[]
}

/** Which resources exist for one discovered PR number. */
export interface StagingCandidate {
  readonly pr: number
  readonly hasService: boolean
  /** Backend DB `pr_N` exists. */
  readonly hasDb: boolean
  /** Control-plane DB `pr_N_cp` exists. */
  readonly hasCpDb: boolean
  readonly hasKvRegion: boolean
}

export interface StagingReconcilePlan {
  /** Discovered PR numbers NOT open+labeled — safe to tear down. */
  readonly orphans: StagingCandidate[]
  /** Discovered PR numbers that ARE open+labeled — left untouched. */
  readonly keep: StagingCandidate[]
}

/**
 * Classify every PR number that owns at least one matching staging resource as
 * either an orphan (tear down) or keep (open+labeled — never touched, even if
 * only some of its resources exist, e.g. a partial deploy in progress).
 *
 * Pure: the strict `STAGING_*_RE` patterns are the only path from a raw name to
 * a candidate number, so nothing outside the `pr_N`/`pr-N` shapes can ever be
 * classified — the safety invariant is structural.
 */
export function classifyStagingOrphans(input: StagingReconcileInput): StagingReconcilePlan {
  const candidates = new Map<number, { hasService: boolean; hasDb: boolean; hasCpDb: boolean; hasKvRegion: boolean }>()

  const get = (pr: number) => {
    let entry = candidates.get(pr)
    if (!entry) {
      entry = { hasService: false, hasDb: false, hasCpDb: false, hasKvRegion: false }
      candidates.set(pr, entry)
    }
    return entry
  }

  for (const name of input.serviceNames) {
    const match = STAGING_SERVICE_RE.exec(name)
    const pr = match ? canonicalPrNumber(match[1]) : null
    if (pr !== null) get(pr).hasService = true
  }

  for (const name of input.dbNames) {
    const match = STAGING_DB_RE.exec(name)
    const pr = match ? canonicalPrNumber(match[1]) : null
    if (match === null || pr === null) continue
    const entry = get(pr)
    if (match[2] === "_cp") entry.hasCpDb = true
    else entry.hasDb = true
  }

  for (const key of input.kvRegionKeys) {
    const match = STAGING_KV_REGION_RE.exec(key)
    const pr = match ? canonicalPrNumber(match[1]) : null
    if (pr !== null) get(pr).hasKvRegion = true
  }

  const openSet = new Set(input.openLabeledPrNumbers)
  const orphans: StagingCandidate[] = []
  const keep: StagingCandidate[] = []

  for (const [pr, resources] of [...candidates.entries()].sort((a, b) => a[0] - b[0])) {
    const candidate: StagingCandidate = { pr, ...resources }
    if (openSet.has(pr)) keep.push(candidate)
    else orphans.push(candidate)
  }

  return { orphans, keep }
}
