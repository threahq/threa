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
  scope: string
  consentId: string
  blockedDecisionVersion: string
  cleanupPending: boolean
  updatedAt: number
}

const AUTHORIZATION_PREFIX = "threa-connectivity-diagnostics:authorization"
const TOMBSTONES_KEY = "threa-connectivity-diagnostics:revocations"
const MAX_TOMBSTONES = 100

function authorizationKey(accountId: string, workspaceId: string): string {
  return `${AUTHORIZATION_PREFIX}:${accountId}:${workspaceId}`
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

function readTombstones(): Record<string, RevocationTombstone> {
  try {
    const parsed = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) ?? "{}") as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, RevocationTombstone] => {
        const value = entry[1] as Partial<RevocationTombstone> | null
        return (
          typeof value?.scope === "string" &&
          typeof value.consentId === "string" &&
          typeof value.blockedDecisionVersion === "string" &&
          typeof value.cleanupPending === "boolean" &&
          typeof value.updatedAt === "number"
        )
      })
    )
  } catch {
    return {}
  }
}

function writeTombstones(tombstones: Record<string, RevocationTombstone>): void {
  try {
    const bounded = Object.entries(tombstones)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_TOMBSTONES)
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(Object.fromEntries(bounded)))
  } catch {
    // Storage is optional. The active runtime and IndexedDB state still revoke.
  }
}

export function readCachedConnectivityAuthorization(
  accountId: string,
  workspaceId: string
): AuthorizedConnectivityDiagnosticsConfig | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(authorizationKey(accountId, workspaceId)) ?? "null")
    if (!isConfig(parsed) || parsed.accountId !== accountId || parsed.workspaceId !== workspaceId) return null
    if (isConnectivityConsentTombstoned(parsed.consentId)) return null
    return parsed
  } catch {
    return null
  }
}

export function cacheConnectivityAuthorization(
  accountId: string,
  config: ConnectivityDiagnosticsConfig,
  decisionVersion: string,
  createId: () => string
): AuthorizedConnectivityDiagnosticsConfig | null {
  const key = authorizationKey(accountId, config.workspaceId)
  const tombstones = readTombstones()
  const revoked = tombstones[key]
  if (revoked && decisionVersion <= revoked.blockedDecisionVersion) return null
  if (revoked) {
    delete tombstones[key]
    writeTombstones(tombstones)
  }

  const existing = readCachedConnectivityAuthorization(accountId, config.workspaceId)
  if (
    existing &&
    existing.token === config.token &&
    existing.host === config.host &&
    existing.userId === config.userId &&
    existing.region === config.region
  ) {
    const refreshed = {
      ...existing,
      decisionVersion: decisionVersion > existing.decisionVersion ? decisionVersion : existing.decisionVersion,
    }
    try {
      localStorage.setItem(key, JSON.stringify(refreshed))
    } catch {
      // Keep the live grant when the cache is unavailable.
    }
    return refreshed
  }

  const authorized = { ...config, accountId, consentId: createId(), decisionVersion }
  try {
    localStorage.setItem(key, JSON.stringify(authorized))
  } catch {
    // A blocked cache disables next-launch restoration, never the current app.
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
  let consentId = fallback?.consentId ?? null
  let blockedDecisionVersion = fallback?.decisionVersion ?? null
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null")
    if (isConfig(parsed) && parsed.accountId === accountId && parsed.workspaceId === workspaceId) {
      consentId = parsed.consentId
      blockedDecisionVersion = parsed.decisionVersion
    }
    localStorage.removeItem(key)
  } catch {
    // Continue with the in-memory authorization when storage is unavailable.
  }
  if (!consentId || !blockedDecisionVersion) return null
  if (revokedDecisionVersion && revokedDecisionVersion > blockedDecisionVersion)
    blockedDecisionVersion = revokedDecisionVersion

  const tombstones = readTombstones()
  tombstones[key] = {
    scope,
    consentId,
    blockedDecisionVersion,
    cleanupPending: true,
    updatedAt: Date.now(),
  }
  writeTombstones(tombstones)
  return consentId
}

export function readPendingConnectivityRevocations(): Array<{ scope: string; consentId: string }> {
  return Object.values(readTombstones())
    .filter((tombstone) => tombstone.cleanupPending)
    .map(({ scope, consentId }) => ({ scope, consentId }))
}

export function isConnectivityConsentTombstoned(consentId: string): boolean {
  return Object.values(readTombstones()).some(
    (tombstone) => tombstone.consentId === consentId && tombstone.cleanupPending
  )
}

export function clearConnectivityConsentTombstone(consentId: string): void {
  const tombstones = readTombstones()
  const entry = Object.entries(tombstones).find(([, tombstone]) => tombstone.consentId === consentId)
  if (!entry) return
  tombstones[entry[0]] = { ...entry[1], cleanupPending: false, updatedAt: Date.now() }
  writeTombstones(tombstones)
}
