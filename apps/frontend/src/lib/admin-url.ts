/**
 * Resolve the backoffice URL from the current app hostname. Local development
 * uses the backoffice Vite server; unknown deployed hosts hide the link.
 */
const ADMIN_URL_BY_HOST: Record<string, string> = {
  "app.threa.io": "https://admin.threa.io",
}

export function getAdminPortalUrl(): string | null {
  const mapped = ADMIN_URL_BY_HOST[window.location.hostname]
  if (mapped) return mapped
  if (import.meta.env.DEV) return "http://localhost:3004"
  return null
}
