import { useRef } from "react"
import { replaceEqualDeep } from "@tanstack/react-query"

/**
 * `next` with every row whose content is unchanged swapped for the object `prev`
 * already held, and `prev` itself when nothing changed. Derived lists are
 * rebuilt on every store write; memoized consumers skip only if identity
 * survives the rebuild.
 */
export function shareById<T extends { id: string }>(prev: readonly T[], next: readonly T[]): T[] {
  const prevById = new Map(prev.map((item) => [item.id, item]))
  let same = prev.length === next.length
  const shared = next.map((item, index) => {
    const before = prevById.get(item.id)
    const kept = before ? replaceEqualDeep(before, item) : item
    if (kept !== prev[index]) same = false
    return kept
  })
  return same ? (prev as T[]) : shared
}

export function useShared<T>(value: T, share: (prev: T, next: T) => T): T {
  const ref = useRef(value)
  ref.current = share(ref.current, value)
  return ref.current
}

/** `prev` when both maps hold the same keys with deep-equal values, otherwise `next`. */
export function shareMap<K, V>(prev: Map<K, V>, next: Map<K, V>): Map<K, V> {
  if (prev.size !== next.size) return next
  for (const [key, value] of next) {
    if (!prev.has(key)) return next
    const held = prev.get(key)
    if (replaceEqualDeep(held, value) !== held) return next
  }
  return prev
}

/**
 * A query `select` for a reader that takes a slice of an entry rewritten more
 * often than the slice changes: returns the slice it last returned while `pick`
 * yields a deep-equal one. One per observer (`useMemo`), never inline.
 */
export function createStableSelect<I, O>(pick: (input: I) => O): (input: I) => O {
  let held: O | undefined
  return (input) => {
    held = replaceEqualDeep(held, pick(input))
    return held as O
  }
}
