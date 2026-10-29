import type { RemoteSession } from "./session"

export function fireIdleTimeout(session: RemoteSession, invocationId: string): Promise<void> {
  return captureIdleTimeout(session, invocationId)()
}

export function captureIdleTimeout(session: RemoteSession, invocationId: string): () => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = session as any
  const route = internals.inflight.get(invocationId)
  const generation = route.deadlineGeneration
  return () => internals.onReplyTimeout(route, generation) as Promise<void>
}

export function gate() {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

/** Settle the promise chains a fake-timer tick started. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}
