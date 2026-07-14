declare const __APP_VERSION__: string
declare const __APP_BUILT_AT__: string

/** This bundle's git-derived build version. */
export function currentAppVersion(): string | null {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null
}

/** UTC timestamp for when this bundle was built. */
export function currentAppBuiltAt(): string | null {
  return typeof __APP_BUILT_AT__ === "string" ? __APP_BUILT_AT__ : null
}

/**
 * Record and return when this build first executed on the device. Called during
 * bundle startup so the value does not depend on when App status is first opened.
 */
export function currentAppInstalledAt(now: Date = new Date()): Date | null {
  const version = currentAppVersion()
  if (!version) return null

  try {
    const key = `app-version-installed-at:${version}`
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
