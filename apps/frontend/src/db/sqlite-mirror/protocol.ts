import type { EncodedRange } from "./key-codec"
import type { WriterCommit } from "./marks"
import type {
  MirrorEntry,
  MirrorMutation,
  MirrorQuery,
  MirrorRow,
  MirrorStatus,
  MirrorStoreSchema,
} from "./mirror-store"

export type MirrorReadRequest =
  | { type: "get"; store: string; key: Uint8Array }
  | { type: "getMany"; store: string; keys: Uint8Array[] }
  | { type: "query"; store: string; query: MirrorQuery }
  | { type: "count"; store: string; index: string | null; range: EncodedRange }

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
  | { type: "forgetWriters"; writers: string[] }
  | { type: "destroy"; idbName: string }
  | MirrorReadRequest

export type MirrorReply =
  | { ok: true; ms: number; status?: MirrorStatus; result?: MirrorReadResults[keyof MirrorReadResults] }
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

/** `started` as the worker begins a request; `reply` once it is done. */
export type WorkerResponse = { id: number; started: true } | { id: number; reply: MirrorReply }
