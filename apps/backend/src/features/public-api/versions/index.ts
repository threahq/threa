import { HttpError } from "@threa/backend-common"
import type { OperationId } from "../routes"
import { API_VERSIONS, CURRENT_API_VERSION, type ApiVersion, type OpenApiSpec, type VersionChange } from "./types"

/**
 * Streams whose wire shape carries the thread anchor: every operation whose
 * response embeds `streamSchema`. `listStreams` (paginated), `getStream` and
 * `updateStream` (data envelope) are the only ones — conversation/search
 * responses carry stream *ids*, not stream objects.
 */
const STREAM_ANCHOR_OPERATIONS = new Set<OperationId>(["listStreams", "getStream", "updateStream"])
const THREAD_ANCHOR_CHANGE_OPERATIONS = new Set<OperationId>([...STREAM_ANCHOR_OPERATIONS, "completeDelegation"])

/** Lower one serialized stream object from the anchorId shape to the legacy parentMessageId shape. */
function downgradeStreamAnchor(stream: Record<string, unknown>): Record<string, unknown> {
  const { anchorId, ...rest } = stream
  // Only message anchors had a `parentMessageId` before; event-anchored threads
  // keep the field absent (older clients never knew that shape).
  if (typeof anchorId === "string" && anchorId.startsWith("msg_")) {
    return { ...rest, parentMessageId: anchorId }
  }
  return rest
}

/** Recursively rewrite the OpenAPI stream schema: drop `anchorId`, restore optional `parentMessageId`. */
function restoreParentMessageIdInSpec(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(restoreParentMessageIdInSpec)
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>
    const props = obj.properties as Record<string, unknown> | undefined
    if (props && "anchorId" in props) {
      const { anchorId: _anchorId, ...restProps } = props
      return {
        ...obj,
        properties: {
          ...Object.fromEntries(Object.entries(restProps).map(([k, v]) => [k, restoreParentMessageIdInSpec(v)])),
          parentMessageId: { type: "string" },
        },
      }
    }
    const restored = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, restoreParentMessageIdInSpec(v)]))
    if (obj.operationId === "completeDelegation") {
      return {
        ...restored,
        description:
          "Complete the claimed delegation. When resultMarkdown is given, a compact resultMessageId anchor is posted to the delegation stream and the full result is posted in resultThreadId. Both writes share the completion transaction. Authenticated with the per-claim token in the X-Threa-Callback-Token header.",
      }
    }
    return restored
  }
  return node
}

/** Ascending by version. Startup assertion enforces ordering + known dates. */
export const VERSION_CHANGES: VersionChange[] = [
  {
    version: "2026-07-22",
    description:
      "Threads can now anchor on cards: stream `parentMessageId` became `anchorId`, and current-version delegation completions put results directly in the card thread while 2026-07-12 retains its synthetic message anchor.",
    operations: THREAD_ANCHOR_CHANGE_OPERATIONS,
    downgradeResponse: (payload, context) => {
      // Completion side effects branch on req.apiVersion before this response
      // transform; resultThreadId is additive and safe for pinned clients.
      if (context.operationId === "completeDelegation") return payload
      if (payload === null || typeof payload !== "object") return payload
      const envelope = payload as Record<string, unknown>
      const data = envelope.data
      if (Array.isArray(data)) {
        return { ...envelope, data: data.map((s) => downgradeStreamAnchor(s as Record<string, unknown>)) }
      }
      if (data && typeof data === "object") {
        return { ...envelope, data: downgradeStreamAnchor(data as Record<string, unknown>) }
      }
      return payload
    },
    downgradeSpec: (spec) => restoreParentMessageIdInSpec(spec) as OpenApiSpec,
  },
]

/** Throws unless every change is strictly newer than the one before it. */
export function assertChangesAscending(changes: readonly VersionChange[]): void {
  for (let i = 1; i < changes.length; i++) {
    if (changes[i - 1].version >= changes[i].version) {
      throw new Error("VERSION_CHANGES must be strictly ascending by version")
    }
  }
}

assertChangesAscending(VERSION_CHANGES)

const KNOWN = new Set<string>(API_VERSIONS)

export function parseApiVersion(raw: string): ApiVersion {
  if (!KNOWN.has(raw)) {
    throw new HttpError(`Unknown API version "${raw}". Known versions: ${API_VERSIONS.join(", ")}`, {
      status: 400,
      code: "INVALID_API_VERSION",
    })
  }
  return raw as ApiVersion
}

/** Changes the caller is behind on, i.e. with version strictly newer than theirs. */
export function changesAfter(clientVersion: ApiVersion, changes: readonly VersionChange[] = VERSION_CHANGES) {
  // ISO dates compare lexicographically — no Date parsing.
  return changes.filter((c) => c.version > clientVersion)
}

/**
 * Derives the OpenAPI spec as it stood at `version` from the current-version
 * `canonical` spec. Applies each newer change's `downgradeSpec` newest→oldest —
 * the same order and predicate the request path uses for `downgradeResponse`
 * (see middleware/api-version.ts) — then stamps `info.version`. Operates on a
 * clone, so the canonical spec is never mutated. The documentation analog of the
 * runtime response downgrade; the OpenAPI generator uses it to emit one spec per
 * version.
 */
export function deriveVersionSpec(
  canonical: OpenApiSpec,
  version: ApiVersion,
  changes: readonly VersionChange[] = VERSION_CHANGES
): OpenApiSpec {
  const pending = changesAfter(version, changes)
  let spec = structuredClone(canonical)
  for (let i = pending.length - 1; i >= 0; i--) {
    const change = pending[i]
    if (change.downgradeSpec) spec = change.downgradeSpec(spec)
  }
  spec.info = { ...(spec.info as Record<string, unknown>), version }
  return spec
}

export { API_VERSIONS, CURRENT_API_VERSION }
export type { ApiVersion, OpenApiSpec, VersionChange, VersionChangeContext } from "./types"
