import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"

interface SelectorStore<T> {
  value: T
  listeners: Set<() => void>
}

/**
 * A context whose consumers re-render only when what they select changes. A
 * plain context re-renders every consumer on any value change, which for a
 * per-row consumer is the whole timeline window on every event.
 */
export function createSelectorContext<T>(defaultValue: T) {
  const Context = createContext<SelectorStore<T> | null>(null)

  function Provider({ value, children }: { value: T; children: ReactNode }) {
    const storeRef = useRef<SelectorStore<T> | null>(null)
    storeRef.current ??= { value, listeners: new Set() }
    const store = storeRef.current
    // Written during render so consumers rendering in this pass read the new
    // value; the ones that did not render are notified once the commit lands.
    store.value = value
    useLayoutEffect(() => {
      for (const listener of store.listeners) listener()
    })
    return <Context.Provider value={store}>{children}</Context.Provider>
  }

  function useSelector<S>(select: (value: T) => S): S {
    const store = useContext(Context)
    const subscribe = useCallback(
      (listener: () => void) => {
        if (!store) return () => {}
        store.listeners.add(listener)
        return () => {
          store.listeners.delete(listener)
        }
      },
      [store]
    )
    const getSnapshot = () => select(store ? store.value : defaultValue)
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }

  return { Provider, useSelector }
}
