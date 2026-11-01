import { createContext, useContext } from "react"
import type { LiveCommitBatch } from "./catch-up-batch"

// Its own module so `stream-store` reaches the batch without importing the
// engine: the service worker bundle inlines `stream-store` through a dynamic
// import, and the engine's module graph (React UI included) breaks the worker.
export const LiveWritesContext = createContext<LiveCommitBatch | null>(null)

export function useLiveWrites(): LiveCommitBatch | null {
  return useContext(LiveWritesContext)
}
