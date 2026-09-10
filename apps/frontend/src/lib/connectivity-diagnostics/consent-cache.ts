export interface ConnectivityDiagnosticsConfig {
  token: string
  host: string
  userId: string
  workspaceId: string
  region: string
}

export interface AuthorizedConnectivityDiagnosticsConfig extends ConnectivityDiagnosticsConfig {
  accountId: string
  consentId: string
  decisionVersion: string
}

interface RevocationTombstone {
  authorizationKey: string
  scope: string
  consentId: string
  blockedDecisionVersion: string
  cleanupPending: boolean
  updatedAt: number
}

const AUTHORIZATION_PREFIX = "threa-connectivity-diagnostics:authorization"
const REVOCATION_PREFIX = "threa-connectivity-diagnostics:revocation"
const MAX_TOMBSTONES = 100

function authorizationKey(accountId: string, workspaceId: string): string {
  return `${AUTHORIZATION_PREFIX}:${accountId}:${workspaceId}`
}

function revocationKey(key: string, decisionVersion: string, consentId: string): string {
  return `${REVOCATION_PREFIX}:${encodeURIComponent(key)}:${encodeURIComponent(decisionVersion)}:${encodeURIComponent(consentId)}:${crypto.randomUUID()}`
}

function isConfig(value: unknown): value is AuthorizedConnectivityDiagnosticsConfig {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<AuthorizedConnectivityDiagnosticsConfig>
  return (
    typeof candidate.accountId === "string" &&
    typeof candidate.consentId === "string" &&
    typeof candidate.decisionVersion === "string" &&
    typeof candidate.token === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.userId === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.region === "string"
  )
}

function isTombstone(value: unknown): value is RevocationTombstone {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<RevocationTombstone>
  return (
    typeof candidate.authorizationKey === "string" &&
    typeof candidate.scope === "string" &&
    typeof candidate.consentId === "string" &&
    typeof candidate.blockedDecisionVersion === "string" &&
    typeof candidate.cleanupPending === "boolean" &&
    typeof candidate.updatedAt === "number"
  )
}

function readStoredAuthorization(key: string): AuthorizedConnectivityDiagnosticsConfig | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null")
    return isConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readTombstones(): Array<{ key: string; value: RevocationTombstone }> {
  try {
    const tombstones: Array<{ key: string; value: RevocationTombstone }> = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith(`${REVOCATION_PREFIX}:`)) continue
      const value = JSON.parse(localStorage.getItem(key) ?? "null")
      if (isTombstone(value)) tombstones.push({ key, value })
    }
    return tombstones
  } catch {
    return []
  }
}

function writeTombstone(tombstone: RevocationTombstone): void {
  try {
    const key = revocationKey(tombstone.authorizationKey, tombstone.blockedDecisionVersion, tombstone.consentId)
    localStorage.setItem(key, JSON.stringify(tombstone))
    const tombstones = readTombstones()
    const retained = new Set([
      key,
      ...tombstones
        .filter((entry) => entry.key !== key)
        .sort((left, right) => right.value.updatedAt - left.value.updatedAt)
        .slice(0, MAX_TOMBSTONES - 1)
        .map((entry) => entry.key),
    ])
    for (const entry of tombstones) {
      if (!retained.has(entry.key)) localStorage.removeItem(entry.key)
    }
  } catch {
    // Storage is optional. The active runtime and IndexedDB state still revoke.
  }
}

function tombstonesFor(key: string): RevocationTombstone[] {
  return readTombstones()
    .map(({ value }) => value)
    .filter((tombstone) => tombstone.authorizationKey === key)
}

function decisionIsBlocked(key: string, decisionVersion: string): boolean {
  return tombstonesFor(key).some((tombstone) => decisionVersion <= tombstone.blockedDecisionVersion)
}

export function readCachedConnectivityAuthorization(
  accountId: string,
  workspaceId: string
): AuthorizedConnectivityDiagnosticsConfig | null {
  const key = authorizationKey(accountId, workspaceId)
  const parsed = readStoredAuthorization(key)
  if (!parsed || parsed.accountId !== accountId || parsed.workspaceId !== workspaceId) return null
  if (decisionIsBlocked(key, parsed.decisionVersion) || isConnectivityConsentTombstoned(parsed.consentId)) return null
  return parsed
}

export function cacheConnectivityAuthorization(
  accountId: string,
  config: ConnectivityDiagnosticsConfig,
  decisionVersion: string,
  createId: () => string
): AuthorizedConnectivityDiagnosticsConfig | null {
  const key = authorizationKey(accountId, config.workspaceId)
  if (decisionIsBlocked(key, decisionVersion)) return null

  const existing = readStoredAuthorization(key)
  const canRefresh =
    existing &&
    !isConnectivityConsentTombstoned(existing.consentId) &&
    existing.token === config.token &&
    existing.host === config.host &&
    existing.userId === config.userId &&
    existing.region === config.region
  const authorized = canRefresh
    ? {
        ...existing,
        decisionVersion: decisionVersion > existing.decisionVersion ? decisionVersion : existing.decisionVersion,
      }
    : { ...config, accountId, consentId: createId(), decisionVersion }

  try {
    localStorage.setItem(key, JSON.stringify(authorized))
  } catch {
    // A blocked cache disables next-launch restoration, never the current app.
  }

  if (decisionIsBlocked(key, authorized.decisionVersion) || isConnectivityConsentTombstoned(authorized.consentId)) {
    return null
  }
  return authorized
}

export function tombstoneConnectivityAuthorization(
  accountId: string,
  workspaceId: string,
  scope: string,
  fallback?: Pick<AuthorizedConnectivityDiagnosticsConfig, "consentId" | "decisionVersion">,
  revokedDecisionVersion?: string
): string | null {
  const key = authorizationKey(accountId, workspaceId)
  const stored = readStoredAuthorization(key)
  const storedApplies = !revokedDecisionVersion || !stored || stored.decisionVersion <= revokedDecisionVersion
  const consentId = stored && storedApplies ? stored.consentId : (fallback?.consentId ?? "")
  const versions = [fallback?.decisionVersion, revokedDecisionVersion]
  if (stored && storedApplies) versions.push(stored.decisionVersion)
  const blockedDecisionVersion = versions
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1)
  if (!blockedDecisionVersion) return null

  writeTombstone({
    authorizationKey: key,
    scope,
    consentId,
    blockedDecisionVersion,
    cleanupPending: consentId !== "" && scope !== "",
    updatedAt: Date.now(),
  })
  return consentId || null
}

export function readPendingConnectivityRevocations(): Array<{ scope: string; consentId: string }> {
  const pending = new Map<string, { scope: string; consentId: string }>()
  for (const { value } of readTombstones()) {
    if (value.cleanupPending) pending.set(`${value.scope}\0${value.consentId}`, value)
  }
  return [...pending.values()].map(({ scope, consentId }) => ({ scope, consentId }))
}

export function readConnectivityConsentTombstones(): Set<string> {
  return new Set(
    readTombstones()
      .map(({ value }) => value.consentId)
      .filter(Boolean)
  )
}

export function isConnectivityConsentTombstoned(consentId: string): boolean {
  return readConnectivityConsentTombstones().has(consentId)
}

export function clearConnectivityConsentTombstone(consentId: string): void {
  for (const entry of readTombstones()) {
    if (entry.value.consentId !== consentId || !entry.value.cleanupPending) continue
    try {
      localStorage.setItem(
        entry.key,
        JSON.stringify({ ...entry.value, cleanupPending: false, updatedAt: Date.now() } satisfies RevocationTombstone)
      )
    } catch {
      // Cleanup will retry from the still-pending in-memory request.
    }
  }
}
