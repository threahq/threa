import type { EncodedRange } from "./key-codec"
import type { WriterCommit } from "./marks"
import type {
  MirrorEntry,
  MirrorMutation,
  MirrorQuery,
  MirrorRow,
  MirrorStatus,
  MirrorStoreSchema,
  MirrorWrite,
} from "./mirror-store"

/** `tx` names the read-write transaction a read belongs to, which sees that transaction's own writes. */
export type MirrorReadRequest = (
  | { type: "get"; store: string; key: Uint8Array }
  | { type: "getMany"; store: string; keys: Uint8Array[] }
  | { type: "query"; store: string; query: MirrorQuery }
  | { type: "count"; store: string; index: string | null; range: EncodedRange }
) & { tx?: number }

/** A committed read-write transaction's writes, still to be replayed into IndexedDB. */
export interface BacklogBatch {
  seq: number
  batch: MirrorMutation[]
}

/** What each read answers with; values stay encoded, `undefined` where no row exists. */
export interface MirrorReadResults {
  get: string | undefined
  getMany: Array<string | undefined>
  query: MirrorRow[]
  count: number
}

export type MirrorRequest =
  | { type: "open"; idbName: string; schema: MirrorStoreSchema[]; idbVersion: number }
  | { type: "apply"; batch: MirrorMutation[]; commit?: WriterCommit }
  | { type: "backfillBegin"; store: string }
  | { type: "backfillChunk"; store: string; entries: MirrorEntry[] }
  | { type: "backfillFinish"; store: string; covered: Record<string, number> }
  | { type: "status" }
  | { type: "reset"; incarnation: string }
  /** Keeps every row and queues all of them for the IndexedDB incarnation named, which lacks them. */
  | { type: "reseed"; incarnation: string }
  | { type: "forgetWriters"; writers: string[] }
  | { type: "destroy"; idbName: string }
  /** Holds every request of other transactions, and outside any, until this one commits or rolls back. */
  | { type: "begin"; tx: number; readonly: boolean }
  | { type: "write"; tx: number; write: MirrorWrite }
  | { type: "commit"; tx: number }
  | { type: "rollback"; tx: number }
  | { type: "backlog"; limit: number }
  | { type: "backlogDone"; through: number }
  | MirrorReadRequest

export type MirrorReply =
  | {
      ok: true
      ms: number
      status?: MirrorStatus
      /** Rows of `_idb_backlog` when the database opened. */
      backlog?: number
      result?: MirrorReadResults[keyof MirrorReadResults]
      /** Positions of a write's entries whose `add` met an existing key. */
      failures?: number[]
      batches?: BacklogBatch[]
    }
  | { ok: false; error: string; message: string }

/** Carries requests to the mirror's owner and resolves each with its reply, in request order. */
export interface MirrorTransport {
  request(request: MirrorRequest): Promise<MirrorReply>
  /** When the worker last reported anything (`performance.now()`), 0 before it has. */
  heardAt(): number
  close(): void
}

export interface WorkerEnvelope {
  id: number
  request: MirrorRequest
}

/** `progress` as the worker begins a request and while a long one runs; `reply` once it is done. */
export type WorkerResponse = { id: number; progress: true } | { id: number; reply: MirrorReply }

/** The transaction a request belongs to, if any. */
export function txOf(request: MirrorRequest): number | undefined {
  return "tx" in request ? request.tx : undefined
}
