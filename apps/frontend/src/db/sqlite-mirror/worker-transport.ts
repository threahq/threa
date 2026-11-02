import type { MirrorReply, MirrorRequest, MirrorTransport, WorkerEnvelope, WorkerResponse } from "./protocol"

export function createWorkerTransport(): MirrorTransport {
  const worker = new Worker(new URL("./mirror-worker.ts", import.meta.url), { type: "module" })
  const pending = new Map<number, { resolve: (reply: MirrorReply) => void; reject: (error: Error) => void }>()
  let nextId = 0

  function rejectAll(error: Error): void {
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }

  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    pending.get(data.id)?.resolve(data.reply)
    pending.delete(data.id)
  }
  worker.onerror = (event) => rejectAll(new Error(event.message || "SQLite mirror worker failed"))

  return {
    request(request: MirrorRequest) {
      return new Promise<MirrorReply>((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        const envelope: WorkerEnvelope = { id, request }
        worker.postMessage(envelope)
      })
    },
    close() {
      worker.terminate()
      rejectAll(new Error("SQLite mirror closed"))
    },
  }
}
