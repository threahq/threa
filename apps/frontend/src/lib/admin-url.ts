/**
 * Resolve the backoffice (admin portal) URL for the environment the app is
 * running in. The frontend ships a single build for prod and staging (the
 * deploy workflow sets no VITE_ vars), so this must be derived at runtime
 * from the page's hostname rather than baked in at build time.
 *
 * Hosts map 1:1 to the backoffice-router routes in
 * `apps/backoffice-router/wrangler.{production,staging}.toml`; the dev
 * fallback is the backoffice Vite dev server port (`apps/backoffice/vite.config.ts`).
 * Unknown hosts (e.g. PR previews) return null — callers hide the link rather
 * than guess an environment.
 */
const ADMIN_URL_BY_HOST: Record<string, string> = {
  "app.threa.io": "https://admin.threa.io",
  "staging.threa.io": "https://admin-staging.threa.io",
}

export function getAdminPortalUrl(): string | null {
  const mapped = ADMIN_URL_BY_HOST[window.location.hostname]
  if (mapped) return mapped
  if (import.meta.env.DEV) return "http://localhost:3004"
  return null
}
