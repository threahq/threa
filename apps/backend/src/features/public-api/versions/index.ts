import { HttpError } from "@threahq/backend-common"
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
    // `id` too: the bot-runtime `attachTo` request body also declares an
    // `anchorId`, and rewriting that one left a body whose `required` named a
    // property it no longer declared under `additionalProperties: false`.
    if (props && "anchorId" in props && "id" in props) {
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

/**
 * Operations whose current-version response carries a top-level `slots` map
 * (every operation returning renderable message markdown). Pins before
 * 2026-07-24 get `slots` stripped; the map is additive so nothing else changes.
 */
const SLOT_MAP_OPERATIONS = new Set<OperationId>([
  "listMessages",
  "sendMessage",
  "listConversationMessages",
  "findMessagesByMetadata",
  "updateMessage",
  "completeBotInvocation",
  "searchMessages",
])

/** Recursively drop any `slots` member (and `required` entries) from an operation's response subtree. */
function removeSlotsFromNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(removeSlotsFromNode)
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>
    const cleaned = Object.fromEntries(
      Object.entries(obj)
        .filter(([key]) => key !== "slots")
        .map(([key, value]) => [key, removeSlotsFromNode(value)])
    )
    if (Array.isArray(obj.required)) {
      cleaned.required = obj.required.filter((entry: unknown) => entry !== "slots")
    }
    return cleaned
  }
  return node
}

/** Strip `slots` from the response schemas of exactly the slot-map operations, leaving every other node untouched. */
function stripSlotsFromSpec(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSlotsFromSpec)
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>
    if (typeof obj.operationId === "string" && SLOT_MAP_OPERATIONS.has(obj.operationId as OperationId)) {
      return { ...obj, responses: removeSlotsFromNode(obj.responses) }
    }
    return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, stripSlotsFromSpec(value)]))
  }
  return node
}

/** Ascending by version. Startup assertion enforces ordering + known dates. */
const LEGACY_SLOT_KEY_PREFIX = "shared:"
const LEGACY_SLOTS_DESCRIPTION =
  "Hydration for cross-stream shared-message pointers in the returned messages, keyed by `shared:<messageId>`. Always present; empty when no message references a shared source."
const PINNED_SLOT_FIELDS = ["version", "currentRevision", "range"]
const LEGACY_SLOT_CONTENT_DESCRIPTION =
  "Source message content as markdown. The canonical rich-text JSON stays internal."

type LegacySlot = Record<string, unknown> & { messageId?: unknown; state?: unknown; version?: unknown; range?: unknown }

function legacySlotPreference(slot: LegacySlot): number {
  if (slot.state !== "ok") return -1
  const version = typeof slot.version === "number" ? slot.version : 0
  return (slot.range == null ? 1_000_000 : 0) + version
}

/**
 * Pins before 2026-08-21 know one key per source (`shared:<messageId>`) and
 * no pin fields. Collapse the reference-keyed map onto that key — the
 * unranged slot at the highest version wins — and drop the pin fields.
 */
function downgradeSlotsToLegacyKeys(slots: Record<string, unknown>): Record<string, unknown> {
  const legacy: Record<string, LegacySlot> = {}
  for (const value of Object.values(slots)) {
    if (!value || typeof value !== "object") continue
    const slot = value as LegacySlot
    if (typeof slot.messageId !== "string") continue
    // A span has no honest older form: this version's reader has no `range` to
    // tell it the content is a fragment, and handing it one under the
    // whole-message key would have it render part of a message as the message.
    // The reference is omitted instead, which the map's contract already allows.
    if (slot.state === "ok" && slot.range != null) continue
    const key = `${LEGACY_SLOT_KEY_PREFIX}${slot.messageId}`
    const existing = legacy[key]
    if (!existing || legacySlotPreference(slot) > legacySlotPreference(existing)) legacy[key] = slot
  }
  return Object.fromEntries(
    Object.entries(legacy).map(([key, slot]) => [
      key,
      Object.fromEntries(Object.entries(slot).filter(([field]) => !PINNED_SLOT_FIELDS.includes(field))),
    ])
  )
}

function stripPinFieldsFromSpec(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPinFieldsFromSpec)
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) out[key] = stripPinFieldsFromSpec(value)
    const props = out.properties as Record<string, unknown> | undefined
    if (props && "currentRevision" in props && "content" in props) {
      // The pin also rewrote prose this version never carried. An older pin has
      // to read exactly as it did before pins existed, description included, or
      // its frozen spec drifts every time the docs are regenerated.
      out.properties = Object.fromEntries(
        Object.entries(props)
          .filter(([field]) => !PINNED_SLOT_FIELDS.includes(field))
          .map(([field, value]) => {
            if (!value || typeof value !== "object") return [field, value]
            if (field === "content") {
              return [field, { ...(value as Record<string, unknown>), description: LEGACY_SLOT_CONTENT_DESCRIPTION }]
            }
            if (field === "attachments") {
              const { description: _pinned, ...rest } = value as Record<string, unknown>
              return [field, rest]
            }
            return [field, value]
          })
      )
      if (Array.isArray(out.required)) {
        out.required = out.required.filter((entry: unknown) => !PINNED_SLOT_FIELDS.includes(entry as string))
      }
    }
    if (typeof out.description === "string" && out.description.startsWith("Hydration for shared-message pointers")) {
      out.description = LEGACY_SLOTS_DESCRIPTION
    }
    return out
  }
  return node
}

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
  {
    version: "2026-07-24",
    description:
      "Message responses now include a top-level `slots` map hydrating cross-stream shared-message pointers (keyed `shared:<messageId>`, markdown content only). Pins before this version have the map stripped.",
    operations: SLOT_MAP_OPERATIONS,
    downgradeResponse: (payload, context) => {
      if (!SLOT_MAP_OPERATIONS.has(context.operationId)) return payload
      if (payload === null || typeof payload !== "object") return payload
      const { slots: _slots, ...rest } = payload as Record<string, unknown>
      return rest
    },
    downgradeSpec: (spec) => stripSlotsFromSpec(spec) as OpenApiSpec,
  },
  {
    version: "2026-08-21",
    description:
      "Shared-message and quote references pin a source revision and optional span. `slots` keys carry the reference (`shared:<messageId>[@<version>[:<from>-<to>]]`), `ok` slots gain `version`, `currentRevision` and `range`, and `content` is the revision the reference names rather than the source as it now reads. Pins before this version still get one `shared:<messageId>` key per source, the whole-message slot at the highest version, without the pin fields; a reference to a span of a message is omitted for those pins, since that shape cannot say it is a fragment.",
    operations: SLOT_MAP_OPERATIONS,
    downgradeResponse: (payload, context) => {
      if (!SLOT_MAP_OPERATIONS.has(context.operationId)) return payload
      if (payload === null || typeof payload !== "object") return payload
      const envelope = payload as Record<string, unknown>
      if (!envelope.slots || typeof envelope.slots !== "object") return payload
      return { ...envelope, slots: downgradeSlotsToLegacyKeys(envelope.slots as Record<string, unknown>) }
    },
    downgradeSpec: (spec) => stripPinFieldsFromSpec(spec) as OpenApiSpec,
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
