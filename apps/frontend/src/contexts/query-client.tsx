import {
  QueryClient,
  QueryClientProvider as TanStackQueryClientProvider,
  QueryCache,
  MutationCache,
} from "@tanstack/react-query"
import { ReactNode } from "react"
import { ApiError, API_BASE } from "@/api/client"
import { useAccountScope } from "@/auth/account-scope"

const AUTH_REDIRECT_KEY = "auth_redirect_count"
const AUTH_REDIRECT_TIMESTAMP_KEY = "auth_redirect_ts"
const MAX_REDIRECTS = 3
const REDIRECT_WINDOW_MS = 30_000

function handleGlobalError(error: Error) {
  if (ApiError.isApiError(error) && error.status === 401) {
    // Prevent redirect loops: track redirects within a time window
    const now = Date.now()
    const lastTs = parseInt(sessionStorage.getItem(AUTH_REDIRECT_TIMESTAMP_KEY) ?? "0", 10)
    const count = parseInt(sessionStorage.getItem(AUTH_REDIRECT_KEY) ?? "0", 10)

    const currentCount = now - lastTs > REDIRECT_WINDOW_MS ? 0 : count

    if (currentCount >= MAX_REDIRECTS) {
      console.error("Auth redirect loop detected. Please clear cookies and try again.")
      return
    }

    sessionStorage.setItem(AUTH_REDIRECT_KEY, String(currentCount + 1))
    sessionStorage.setItem(AUTH_REDIRECT_TIMESTAMP_KEY, String(now))

    const currentPath = window.location.pathname + window.location.search
    window.location.href = `${API_BASE}/api/auth/login?redirect_to=${encodeURIComponent(currentPath)}`
  }
}

export function makeQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: handleGlobalError,
    }),
    mutationCache: new MutationCache({
      onError: handleGlobalError,
    }),
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        refetchOnWindowFocus: true,
        retry: false,
      },
    },
  })
}

interface AccountQueryClientProviderProps {
  children: ReactNode
}

// Mounts the *active account's* QueryClient. Rendered inside AccountScope's
// keyed remount boundary, so an account switch tears this down and remounts
// it bound to the new account's client — caches never share an instance
// across accounts. The 401 redirect + its sessionStorage loop-guard in
// handleGlobalError stay global and correct: only one account's client is
// ever mounted at a time.
export function AccountQueryClientProvider({ children }: AccountQueryClientProviderProps) {
  const { getQueryClient } = useAccountScope()
  return <TanStackQueryClientProvider client={getQueryClient()}>{children}</TanStackQueryClientProvider>
}
