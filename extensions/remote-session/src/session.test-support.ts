import type { RemoteSession } from "./session"

export function fireIdleTimeout(session: RemoteSession, invocationId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = session as any
  const route = internals.inflight.get(invocationId)
  return internals.onReplyTimeout(route, route.deadlineGeneration) as Promise<void>
}

export function gate() {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}
