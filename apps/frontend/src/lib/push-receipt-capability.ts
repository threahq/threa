import { SW_MSG_QUERY_STATUS, SW_MSG_STATUS_REPLY } from "@/lib/sw-messages"

/** The subscribe handshake waits at most this long for the worker's answer, then registers as unknown. */
const RECEIPT_VERSION_QUERY_TIMEOUT_MS = 1_000

/**
 * The receipt protocol the registration's ACTIVE worker advertises in its
 * STATUS_REPLY (`pushReceiptVersion`). The active worker is the one that
 * handles pushes, so a newer page or a waiting worker proves nothing. Null
 * when there is no active worker, it predates receipts, or it does not answer
 * in time: the backend then treats the device as unknown and issues no
 * receipt capability to it.
 */
export function queryActiveWorkerReceiptVersion(
  registration: ServiceWorkerRegistration,
  timeoutMs = RECEIPT_VERSION_QUERY_TIMEOUT_MS
): Promise<number | null> {
  const worker = registration.active
  if (!worker) return Promise.resolve(null)
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    let settled = false
    const finish = (version: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.port1.onmessage = null
      channel.port1.close()
      resolve(version)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown; pushReceiptVersion?: unknown } | undefined
      const version = data?.pushReceiptVersion
      finish(
        data?.type === SW_MSG_STATUS_REPLY && typeof version === "number" && Number.isInteger(version) && version >= 1
          ? version
          : null
      )
    }
    try {
      worker.postMessage({ type: SW_MSG_QUERY_STATUS }, [channel.port2])
    } catch {
      finish(null)
    }
  })
}
