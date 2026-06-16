// Thin re-export so tests can spy on sonner's exports via a local (mutable)
// ESM namespace. Sonner's own package namespace is frozen and not spy-able.
//
// Toast policy (INV-63): success is silent. Don't pop `toast.success` for a
// happy path the UI already reflects — reserve toasts for errors, warnings, and
// deferred/offline state, and confirm clipboard/download in place. See the root
// CLAUDE.md and `no-happy-path-success-toast.test.ts`.
export { Toaster as SonnerRoot, toast, useSonner } from "sonner"
export type { ToastT } from "sonner"
