// The app origin: app.threa.io serves the app UI, and the workspace-router
// proxies /api/* on the same host, so this doubles as the API base for the
// waitlist POST. Overridable at build via PUBLIC_API_BASE so staging/preview
// builds of the marketing site don't point users at production.
export const apiBase = import.meta.env.PUBLIC_API_BASE ?? "https://app.threa.io"

export const loginUrl = `${apiBase}/login`
