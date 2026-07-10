import { createContext, useContext, useEffect, useCallback, useMemo, type ReactNode } from "react"
import { useQueryClient, useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { preferencesApi } from "@/api"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useWorkspaceUserPreferences } from "@/stores/workspace-store"
import { db } from "@/db"
import { useAccountScopeOptional } from "@/auth/account-scope"
import { applyPreferencesToDOM, getResolvedTheme } from "@/lib/apply-preferences"
import type {
  UserPreferences,
  UpdateUserPreferencesInput,
  AccessibilityPreferences,
  WorkspaceBootstrap,
} from "@threa/types"

const APPEARANCE_STORAGE_KEY = "threa-appearance"

/**
 * Caches appearance-related preferences to localStorage for early application
 * before React mounts. See index.html inline script.
 *
 * Writes the account-scoped key (authoritative per account) AND the global
 * key: the render-blocking inline script in index.html runs before any
 * account is known, so it can only read the un-namespaced key. The global
 * copy is therefore a one-frame pre-auth fallback (it may briefly show the
 * prior account's theme); this provider re-applies the correct per-account
 * appearance on mount.
 */
function cacheAppearanceToLocalStorage(prefs: UserPreferences, accountId: string | null) {
  const appearance = {
    theme: prefs.theme,
    fontSize: prefs.accessibility.fontSize,
    fontFamily: prefs.accessibility.fontFamily,
    reducedMotion: prefs.accessibility.reducedMotion,
    highContrast: prefs.accessibility.highContrast,
    messageDisplay: prefs.messageDisplay,
  }
  const serialized = JSON.stringify(appearance)
  localStorage.setItem(APPEARANCE_STORAGE_KEY, serialized)
  if (accountId) {
    localStorage.setItem(`${APPEARANCE_STORAGE_KEY}:${accountId}`, serialized)
  }
}

interface PreferencesContextValue {
  preferences: UserPreferences | null
  resolvedTheme: "light" | "dark"
  isLoading: boolean
  updatePreference: <K extends keyof UpdateUserPreferencesInput>(
    key: K,
    value: UpdateUserPreferencesInput[K]
  ) => Promise<void>
  /** Write several keys in one request — use when two fields must move together
   *  (e.g. setting the board home lens must also clear `boardDefaultViewId`). */
  updatePreferences: (input: UpdateUserPreferencesInput) => Promise<void>
  updateAccessibility: (updates: Partial<AccessibilityPreferences>) => Promise<void>
  updateKeyboardShortcut: (actionId: string, keyBinding: string) => Promise<void>
  resetKeyboardShortcut: (actionId: string) => Promise<void>
  resetAllKeyboardShortcuts: () => Promise<void>
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null)

interface PreferencesProviderProps {
  workspaceId: string
  children: ReactNode
}

export function PreferencesProvider({ workspaceId, children }: PreferencesProviderProps) {
  const queryClient = useQueryClient()

  // Read preferences from IDB via useLiveQuery — reactive and offline-capable
  const idbPrefs = useWorkspaceUserPreferences(workspaceId)
  const preferences = (idbPrefs as UserPreferences | undefined) ?? null

  const resolvedTheme = useMemo(() => {
    if (!preferences) return "light"
    return getResolvedTheme(preferences.theme)
  }, [preferences])

  const accountId = useAccountScopeOptional()?.activeWorkosUserId ?? null

  // Apply preferences to DOM and cache for early application on next load
  useEffect(() => {
    if (!preferences) return
    applyPreferencesToDOM(preferences)
    cacheAppearanceToLocalStorage(preferences, accountId)
  }, [preferences, accountId])

  // Listen for system theme changes when in "system" mode
  useEffect(() => {
    if (!preferences || preferences.theme !== "system") return

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      applyPreferencesToDOM(preferences)
    }

    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [preferences])

  const mutation = useMutation({
    mutationFn: (input: UpdateUserPreferencesInput) => preferencesApi.update(workspaceId, input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })

      const previousBootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))

      if (previousBootstrap?.userPreferences) {
        const newPreferences: UserPreferences = {
          ...previousBootstrap.userPreferences,
          ...input,
          // Handle partial accessibility updates
          accessibility:
            input.accessibility !== undefined
              ? { ...previousBootstrap.userPreferences.accessibility, ...input.accessibility }
              : previousBootstrap.userPreferences.accessibility,
          // Keyboard shortcuts: callers provide the complete desired state, so replace entirely
          keyboardShortcuts:
            input.keyboardShortcuts !== undefined
              ? input.keyboardShortcuts
              : previousBootstrap.userPreferences.keyboardShortcuts,
          updatedAt: new Date().toISOString(),
        }

        queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), {
          ...previousBootstrap,
          userPreferences: newPreferences,
        })

        // Write to IDB immediately so useLiveQuery consumers see the change
        // without waiting for the socket event round-trip.
        db.userPreferences.put({
          ...newPreferences,
          id: workspaceId,
          workspaceId,
          _cachedAt: Date.now(),
        })
      }

      return { previousBootstrap }
    },
    onError: (_err, _input, context) => {
      // Rollback on error — both TanStack and IDB
      if (context?.previousBootstrap) {
        queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), context.previousBootstrap)
        if (context.previousBootstrap.userPreferences) {
          db.userPreferences.put({
            ...context.previousBootstrap.userPreferences,
            id: workspaceId,
            workspaceId,
            _cachedAt: Date.now(),
          })
        }
      }
      toast.error("Failed to save settings")
    },
    onSuccess: (newPreferences) => {
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        return { ...old, userPreferences: newPreferences }
      })
    },
  })

  const updatePreference = useCallback(
    async <K extends keyof UpdateUserPreferencesInput>(key: K, value: UpdateUserPreferencesInput[K]) => {
      await mutation.mutateAsync({ [key]: value } as UpdateUserPreferencesInput)
    },
    [mutation]
  )

  const updatePreferences = useCallback(
    async (input: UpdateUserPreferencesInput) => {
      await mutation.mutateAsync(input)
    },
    [mutation]
  )

  const updateAccessibility = useCallback(
    async (updates: Partial<AccessibilityPreferences>) => {
      await mutation.mutateAsync({ accessibility: updates })
    },
    [mutation]
  )

  const updateKeyboardShortcut = useCallback(
    async (actionId: string, keyBinding: string) => {
      const currentShortcuts = { ...(preferences?.keyboardShortcuts ?? {}) }
      currentShortcuts[actionId] = keyBinding
      await mutation.mutateAsync({ keyboardShortcuts: currentShortcuts })
    },
    [mutation, preferences?.keyboardShortcuts]
  )

  const resetKeyboardShortcut = useCallback(
    async (actionId: string) => {
      const currentShortcuts = { ...(preferences?.keyboardShortcuts ?? {}) }
      delete currentShortcuts[actionId]
      await mutation.mutateAsync({ keyboardShortcuts: currentShortcuts })
    },
    [mutation, preferences?.keyboardShortcuts]
  )

  const resetAllKeyboardShortcuts = useCallback(async () => {
    await mutation.mutateAsync({ keyboardShortcuts: {} })
  }, [mutation])

  const value = useMemo<PreferencesContextValue>(
    () => ({
      preferences,
      resolvedTheme,
      isLoading: mutation.isPending,
      updatePreference,
      updatePreferences,
      updateAccessibility,
      updateKeyboardShortcut,
      resetKeyboardShortcut,
      resetAllKeyboardShortcuts,
    }),
    [
      preferences,
      resolvedTheme,
      mutation.isPending,
      updatePreference,
      updatePreferences,
      updateAccessibility,
      updateKeyboardShortcut,
      resetKeyboardShortcut,
      resetAllKeyboardShortcuts,
    ]
  )

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export function usePreferences(): PreferencesContextValue {
  const context = useContext(PreferencesContext)
  if (!context) {
    throw new Error("usePreferences must be used within a PreferencesProvider")
  }
  return context
}

/**
 * Same as `usePreferences`, but returns `null` when no provider is mounted.
 * Used by components that can render in both workspace and standalone
 * contexts (markdown previews, tests) without forcing every caller to
 * bundle the provider.
 */
export function usePreferencesOptional(): PreferencesContextValue | null {
  return useContext(PreferencesContext)
}

/**
 * Hook to get the current theme (for components that need to know the resolved theme)
 */
export function useResolvedTheme(): "light" | "dark" {
  const { resolvedTheme } = usePreferences()
  return resolvedTheme
}
