import type { MirrorEntry, MirrorMutation } from "./mirror-store"

export type MirrorRequest =
  | { type: "open"; idbName: string; stores: string[]; idbVersion: number }
  | { type: "apply"; batch: MirrorMutation[] }
  | { type: "backfillBegin"; store: string }
  | { type: "backfillChunk"; store: string; entries: MirrorEntry[] }
  | { type: "backfillFinish"; store: string }
  | { type: "status" }
  | { type: "destroy"; idbName: string }

export type MirrorReply =
  | { ok: true; ms: number; backfilled?: string[] }
  | { ok: false; error: string; message: string }

/** Carries requests to the mirror's owner and resolves each with its reply, in request order. */
export interface MirrorTransport {
  request(request: MirrorRequest): Promise<MirrorReply>
  close(): void
}

export interface WorkerEnvelope {
  id: number
  request: MirrorRequest
}

export interface WorkerResponse {
  id: number
  reply: MirrorReply
}
