export const BOOTSTRAP_DIFF_IGNORED_KEYS: ReadonlySet<string> = new Set(["_cachedAt"])

/**
 * For payload fields whose timestamps carry no data: the server synthesises both
 * with `new Date()` on every read (`mergeOverrides` in the user-preferences and
 * workspace-settings services — only the individual overrides are stored), so an
 * unchanged value arrives with two fresh stamps on every bootstrap and would be
 * rewritten forever. Applies to the compared value's own keys only.
 */
export const SERVER_STAMP_IGNORED_KEYS: ReadonlySet<string> = new Set([
  ...BOOTSTRAP_DIFF_IGNORED_KEYS,
  "createdAt",
  "updatedAt",
])

export interface RowDiff<T> {
  toWrite: T[]
  merged: T[]
  skipped: number
}

export interface SingletonDiff<T> {
  write: boolean
  merged: T
}

function isPlainObjectOrArray(value: object): boolean {
  const tag = Object.prototype.toString.call(value)
  return tag === "[object Object]" || tag === "[object Array]"
}

/**
 * The caller's ignore set applies to the compared value's own keys only; nested
 * values fall back to the base set, so ignoring a synthesized top-level stamp
 * cannot blind the comparison to a real nested `updatedAt`.
 */
export function semanticEqual(
  a: unknown,
  b: unknown,
  ignoreKeys: ReadonlySet<string> = BOOTSTRAP_DIFF_IGNORED_KEYS
): boolean {
  return semanticEqualAt(a, b, ignoreKeys)
}

function semanticEqualAt(a: unknown, b: unknown, ignoreKeys: ReadonlySet<string>): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false

  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false
  // Exotic instances (Date/Map/Set/RegExp) carry no own enumerable keys, so a
  // plain key walk would call every pair equal and silently skip the write.
  // Reference identity is the only equality we can prove here: they always write.
  if (!isPlainObjectOrArray(a) || !isPlainObjectOrArray(b)) return Object.is(a, b)
  if (aIsArray) {
    const left = a as unknown[]
    const right = b as unknown[]
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
      if (!semanticEqualAt(left[i], right[i], BOOTSTRAP_DIFF_IGNORED_KEYS)) return false
    }
    return true
  }

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set<string>()
  for (const key of Object.keys(left)) if (!ignoreKeys.has(key)) keys.add(key)
  for (const key of Object.keys(right)) if (!ignoreKeys.has(key)) keys.add(key)
  for (const key of keys) {
    if (!semanticEqualAt(left[key], right[key], BOOTSTRAP_DIFF_IGNORED_KEYS)) return false
  }
  return true
}

export function diffRows<T extends { id: string }>(
  existing: ReadonlyMap<string, T>,
  candidates: T[],
  ignoreKeys: ReadonlySet<string> = BOOTSTRAP_DIFF_IGNORED_KEYS
): RowDiff<T> {
  const toWrite: T[] = []
  const merged: T[] = []
  let skipped = 0
  for (const candidate of candidates) {
    const previous = existing.get(candidate.id)
    if (previous !== undefined && semanticEqual(previous, candidate, ignoreKeys)) {
      merged.push(previous)
      skipped += 1
      continue
    }
    toWrite.push(candidate)
    merged.push(candidate)
  }
  return { toWrite, merged, skipped }
}

export function writeAllRows<T extends { id: string }>(candidates: T[]): RowDiff<T> {
  return { toWrite: candidates, merged: candidates, skipped: 0 }
}

export function diffSingleton<T>(
  existing: T | undefined,
  candidate: T,
  ignoreKeys: ReadonlySet<string> = BOOTSTRAP_DIFF_IGNORED_KEYS
): SingletonDiff<T> {
  if (existing !== undefined && semanticEqual(existing, candidate, ignoreKeys)) {
    return { write: false, merged: existing }
  }
  return { write: true, merged: candidate }
}

export type ConfirmableTable = "streams" | "streamMemberships" | "streamReadState"

// A skipped row keeps its old `_cachedAt` (no IDB write), but the local-wins
// gates read that stamp as "when did we last know this row matched the server".
// Confirmations restore that meaning without a write; per-JS-context is the
// correct scope, since the gates compare against this context's fetch windows.
const rowConfirmations = new Map<string, number>()

function confirmationKey(workspaceId: string, table: ConfirmableTable, id: string): string {
  return `${workspaceId}/${table}/${id}`
}

export function recordRowConfirmation(workspaceId: string, table: ConfirmableTable, id: string, at: number): void {
  const key = confirmationKey(workspaceId, table, id)
  const previous = rowConfirmations.get(key)
  if (previous !== undefined && previous >= at) return
  rowConfirmations.set(key, at)
}

export function rowConfirmedAt(workspaceId: string, table: ConfirmableTable, id: string): number | undefined {
  return rowConfirmations.get(confirmationKey(workspaceId, table, id))
}

export function effectiveFreshness(workspaceId: string, table: ConfirmableTable, id: string, cachedAt: number): number {
  const confirmed = rowConfirmations.get(confirmationKey(workspaceId, table, id))
  return confirmed !== undefined && confirmed > cachedAt ? confirmed : cachedAt
}

export function removeRowConfirmations(workspaceId: string, table: ConfirmableTable, ids: Iterable<string>): void {
  for (const id of ids) {
    rowConfirmations.delete(confirmationKey(workspaceId, table, id))
  }
}

export function resetRowConfirmations(): void {
  rowConfirmations.clear()
}

export function recordSkippedRowConfirmations<T extends { id: string }>(
  workspaceId: string,
  table: ConfirmableTable,
  diff: RowDiff<T>,
  at: number
): void {
  if (diff.skipped === 0) return
  const written = new Set(diff.toWrite.map((row) => row.id))
  for (const row of diff.merged) {
    if (written.has(row.id)) continue
    recordRowConfirmation(workspaceId, table, row.id, at)
  }
}
