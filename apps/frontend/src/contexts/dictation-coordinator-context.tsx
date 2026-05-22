import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react"

interface DictationCoordinatorContextValue {
  /**
   * Register this take as the single active dictation, stopping whichever take
   * was active before. `stop` is the registering take's own stop callback; it is
   * invoked on the previously-active take so it flushes its in-flight hypothesis
   * and tears down before the new take begins.
   */
  activate: (stop: () => void) => void
  /** Release the active slot if `stop` still holds it (no-op otherwise). */
  deactivate: (stop: () => void) => void
}

const DictationCoordinatorContext = createContext<DictationCoordinatorContextValue | null>(null)

// Standalone fallback so the dictation hook works without a provider mounted
// (tests, isolated stories). With no shared slot there is nothing to stop, so
// activation/deactivation are inert.
const NOOP_COORDINATOR: DictationCoordinatorContextValue = {
  activate: () => {},
  deactivate: () => {},
}

export function DictationCoordinatorProvider({ children }: { children: ReactNode }) {
  // Holds the active take's stop callback. Only one take dictates at a time;
  // starting another flushes and stops this one first.
  const activeStopRef = useRef<(() => void) | null>(null)

  const activate = useCallback((stop: () => void) => {
    const previous = activeStopRef.current
    activeStopRef.current = stop
    if (previous && previous !== stop) previous()
  }, [])

  const deactivate = useCallback((stop: () => void) => {
    if (activeStopRef.current === stop) activeStopRef.current = null
  }, [])

  const value = useMemo<DictationCoordinatorContextValue>(() => ({ activate, deactivate }), [activate, deactivate])

  return <DictationCoordinatorContext.Provider value={value}>{children}</DictationCoordinatorContext.Provider>
}

export function useDictationCoordinator(): DictationCoordinatorContextValue {
  return useContext(DictationCoordinatorContext) ?? NOOP_COORDINATOR
}
