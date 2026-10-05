import {
  createContext,
  useContext,
  useInsertionEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
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
    const [store] = useState<SelectorStore<T>>(() => ({ value, listeners: new Set() }))
    // Written on commit, never during render: a navigation renders inside a
    // transition that can sit uncommitted for seconds, and a render-phase write
    // would hand its value to the rows still on screen.
    useInsertionEffect(() => {
      store.value = value
    }, [store, value])
    useLayoutEffect(() => {
      for (const listener of store.listeners) listener()
    }, [store, value])
    return <Context.Provider value={store}>{children}</Context.Provider>
  }

  function useSelector<S>(select: (value: T) => S): S {
    const store = useContext(Context)
    const [, rerender] = useReducer((count: number) => count + 1, 0)
    const selected = select(store ? store.value : defaultValue)
    const latest = useRef({ select, selected })
    // A consumer rendering in the pass that changes the value read the previous
    // one; this catches it up before paint.
    useLayoutEffect(() => {
      latest.current = { select, selected }
      if (store && !Object.is(select(store.value), selected)) rerender()
    })
    useLayoutEffect(() => {
      if (!store) return
      const listener = () => {
        const { select: latestSelect, selected: latestSelected } = latest.current
        if (!Object.is(latestSelect(store.value), latestSelected)) rerender()
      }
      store.listeners.add(listener)
      return () => {
        store.listeners.delete(listener)
      }
    }, [store])
    return selected
  }

  return { Provider, useSelector }
}
