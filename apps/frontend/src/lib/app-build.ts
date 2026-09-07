declare const __APP_VERSION__: string
declare const __APP_BUILT_AT__: string
declare const __APP_BUILD_ID__: string

/** This bundle's git-derived build version. */
export function currentAppVersion(): string | null {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null
}

/** UTC timestamp for when this bundle was built. */
export function currentAppBuiltAt(): string | null {
  return typeof __APP_BUILT_AT__ === "string" ? __APP_BUILT_AT__ : null
}

/**
 * Unique artifact identity for this bundle: version + build timestamp. The same
 * git commit rebuilt produces a different build id, so precache identity and
 * update notifications key off the actual artifact, not the version alone.
 */
export function currentAppBuildId(): string | null {
  return typeof __APP_BUILD_ID__ === "string" ? __APP_BUILD_ID__ : null
}

/**
 * Record and return when this build first executed on the device. Called during
 * bundle startup so the value does not depend on when App status is first opened.
 * Keyed by build id, not version: a rebuild of the same commit is a different
 * artifact (see currentAppBuildId) and must not inherit a prior rebuild's
 * install timestamp.
 */
export function currentAppInstalledAt(now: Date = new Date()): Date | null {
  const buildId = currentAppBuildId()
  if (!buildId) return null

  try {
    const key = `app-build-installed-at:${buildId}`
    const stored = localStorage.getItem(key)
    if (stored) {
      const parsed = new Date(stored)
      if (!Number.isNaN(parsed.getTime())) return parsed
    }
    localStorage.setItem(key, now.toISOString())
    return now
  } catch {
    return null
  }
}
