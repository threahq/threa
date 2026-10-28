/** How many panes and tabs show each doc; a doc counts as open while any does. */
const openCounts = new Map<string, number>()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

/** Marks a doc open until the returned release runs. */
export function registerOpenDoc(docId: string): () => void {
  const count = openCounts.get(docId) ?? 0
  openCounts.set(docId, count + 1)
  if (count === 0) notify()

  return () => {
    const remaining = openCounts.get(docId)! - 1
    if (remaining > 0) {
      openCounts.set(docId, remaining)
      return
    }
    openCounts.delete(docId)
    notify()
  }
}

/** The docs open on this device, in the order they were opened. */
export function getOpenDocIds(): string[] {
  return [...openCounts.keys()]
}

/** Calls the listener whenever a doc opens or the last pane showing one closes. */
export function subscribeOpenDocs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: forgets every open doc and listener between cases. */
export function resetOpenDocsForTest(): void {
  openCounts.clear()
  listeners.clear()
}
