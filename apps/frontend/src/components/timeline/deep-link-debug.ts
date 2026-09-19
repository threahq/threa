/**
 * Opt-in deep-link scroll tracing. Off by default (zero console noise in
 * production). Enable from the browser console with
 * `window.__threaDeepLinkDebug = true`, then reproduce a deep-link (`?m=`)
 * navigation — every jump result, skeleton-hold transition, scroll bail
 * reason, and convergence decision is logged so a remaining "never scrolls
 * into view" miss is diagnosable without another instrumentation round-trip.
 */
export function deepLinkDebug(...args: unknown[]) {
  if (typeof window !== "undefined" && (window as { __threaDeepLinkDebug?: boolean }).__threaDeepLinkDebug) {
    console.debug("[deeplink]", ...args)
  }
}
