import type { RenderableMessage } from "@/components/message/message-item"

/**
 * The stream-graph fields grouping needs: the parent pointers that place a
 * message's stream in the thread tree. `CachedStream` satisfies this
 * structurally, so a card passes its cached streams straight through; tests pass
 * plain objects.
 */
export interface BranchStreamNode {
  parentStreamId: string | null
  rootStreamId: string | null
  /** The anchor this stream (a thread) forks off — its fork point in the parent
   *  stream. Board branches are message-anchored (event-anchored board rendering
   *  is deferred), so this carries the `msg_` fork id. */
  parentAnchorId?: string | null
  /** Legacy IDB cached rows (pre anchor unification) carry the fork id here
   *  instead of `parentAnchorId`; read both so an offline-first startup keeps
   *  the fork point until the next online bootstrap rewrites the row. */
  parentMessageId?: string | null
}

/**
 * One occupied stream's slot in a conversation's render tree. A `BranchNode`
 * holds the conversation's own messages that live in `streamId` (chronological)
 * and the child threads that fork off them.
 */
export interface BranchNode {
  streamId: string
  /** Parent-stream hops from `streamId` up to the conversation's effective root. */
  depth: number
  /** `min(depth - shallowest occupied depth, 2)` — the indent level; base renders at 0. */
  displayDepth: number
  /** `depth - shallowest occupied depth > 2`: collapse this subtree behind a "continue thread" row. */
  overflow: boolean
  /** The parent-stream message this node hangs off, or null for a base node / a
   *  node whose fork point isn't rendered (then it anchors chronologically). */
  forkMessageId: string | null
  messages: RenderableMessage[]
  children: BranchNode[]
}

/**
 * How a card's already-displayed messages render across their streams:
 *
 * - `flat` — one occupied stream; render chronological, no indent.
 * - `soft` — exactly two occupied streams crossed once (convert-to-thread, the
 *   Slack thread→root case); render flat with a single "continued in …" seam,
 *   no indent (the thread is transport, not a branch).
 * - `spanning` — genuine back-and-forth across ≥2 boundaries; render Reddit-style
 *   with each thread indented one level per boundary (capped at 2, deeper behind
 *   an overflow row).
 */
export interface BranchGrouping {
  kind: "flat" | "soft" | "spanning"
  /** Base-level nodes (shallowest occupied depth), each carrying its subtree. */
  roots: BranchNode[]
  /** Present only for `soft`: the seam between the two runs. */
  softSeam?: { streamId: string; afterMessageId: string | null; direction: "down" | "up" }
}

export interface BranchGroupingContext {
  /** Every stream the conversation might occupy or walk through, by id. */
  streams: Map<string, BranchStreamNode>
  /** The conversation's anchor stream — its effective root terminates depth walks. */
  conversation: { streamId: string }
}

function timeMs(message: RenderableMessage): number {
  return new Date(message.createdAt).getTime()
}

const MAX_WALK = 64

/**
 * Group a conversation's rendered messages into its stream-boundary render tree.
 * Pure: depends only on the messages (each carrying its own `streamId`), the
 * stream graph, and the conversation's anchor. Never throws on an unresolvable
 * parent chain — such a stream renders at the base level (see adjustment A).
 */
export function groupBranches(messages: RenderableMessage[], ctx: BranchGroupingContext): BranchGrouping {
  const { streams, conversation } = ctx
  const ordered = [...messages].sort((a, b) => timeMs(a) - timeMs(b))

  // First-appearance order of the streams the conversation's messages occupy.
  const occupied: string[] = []
  const occupiedSet = new Set<string>()
  for (const message of ordered) {
    const streamId = message.streamId ?? conversation.streamId
    if (!occupiedSet.has(streamId)) {
      occupiedSet.add(streamId)
      occupied.push(streamId)
    }
  }

  const conversationRoot = streams.get(conversation.streamId)?.rootStreamId ?? conversation.streamId

  const messagesByStream = new Map<string, RenderableMessage[]>()
  for (const message of ordered) {
    const streamId = message.streamId ?? conversation.streamId
    const list = messagesByStream.get(streamId)
    if (list) list.push(message)
    else messagesByStream.set(streamId, [message])
  }

  const flatNode = (streamId: string): BranchNode => ({
    streamId,
    depth: 0,
    displayDepth: 0,
    overflow: false,
    forkMessageId: null,
    messages: messagesByStream.get(streamId) ?? [],
    children: [],
  })

  if (occupied.length <= 1) {
    return { kind: "flat", roots: [flatNode(occupied[0] ?? conversation.streamId)] }
  }

  // Number of stream boundaries the chronological sequence crosses.
  let transitions = 0
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1].streamId ?? conversation.streamId
    const cur = ordered[i].streamId ?? conversation.streamId
    if (prev !== cur) transitions++
  }

  if (occupied.length === 2 && transitions === 1) {
    const firstStream = occupied[0]
    let idx = ordered.findIndex((m) => (m.streamId ?? conversation.streamId) !== firstStream)
    if (idx < 0) idx = ordered.length
    const secondStream = (ordered[idx]?.streamId ?? conversation.streamId) as string
    const run1 = ordered.slice(0, idx)
    const run2 = ordered.slice(idx)
    const dFirst = depthOf(firstStream, streams, conversationRoot)
    const dSecond = depthOf(secondStream, streams, conversationRoot)
    return {
      kind: "soft",
      roots: [
        { ...flatNode(firstStream), messages: run1 },
        { ...flatNode(secondStream), messages: run2 },
      ],
      softSeam: {
        streamId: secondStream,
        afterMessageId: run1.at(-1)?.id ?? null,
        direction: dSecond >= dFirst ? "down" : "up",
      },
    }
  }

  // Spanning: place each occupied stream by its absolute depth, normalized so the
  // shallowest occupied level renders at indent 0 (adjustment A).
  const depths = new Map<string, number>()
  for (const streamId of occupied) depths.set(streamId, depthOf(streamId, streams, conversationRoot))
  let minOccupied = Infinity
  for (const depth of depths.values()) if (depth < minOccupied) minOccupied = depth

  const nodesByStream = new Map<string, BranchNode>()
  for (const streamId of occupied) {
    const depth = depths.get(streamId) ?? 0
    const rel = depth - minOccupied
    nodesByStream.set(streamId, {
      streamId,
      depth,
      displayDepth: Math.min(rel, 2),
      overflow: rel > 2,
      forkMessageId: streams.get(streamId)?.parentAnchorId ?? streams.get(streamId)?.parentMessageId ?? null,
      messages: messagesByStream.get(streamId) ?? [],
      children: [],
    })
  }

  const roots: BranchNode[] = []
  for (const streamId of occupied) {
    if ((depths.get(streamId) ?? 0) !== minOccupied) continue
    const node = nodesByStream.get(streamId)!
    node.forkMessageId = null
    roots.push(node)
  }

  for (const streamId of occupied) {
    if ((depths.get(streamId) ?? 0) === minOccupied) continue
    const node = nodesByStream.get(streamId)!
    const ancestor = nearestOccupiedAncestor(streamId, streams, occupiedSet)
    if (ancestor && nodesByStream.has(ancestor)) {
      nodesByStream.get(ancestor)!.children.push(node)
    } else {
      // Fork point unrendered (no occupied ancestor): anchor chronologically at
      // the base level, keeping its own indent.
      node.forkMessageId = null
      roots[0].children.push(node)
    }
  }

  return { kind: "spanning", roots }
}

/** Parent-stream hops from `streamId` up to the conversation root. An unresolvable
 *  chain (a stream not in cache, or a broken parent link) collapses to 0 — the
 *  base level — never a throw (adjustment A). */
function depthOf(streamId: string, streams: Map<string, BranchStreamNode>, conversationRoot: string): number {
  let currentId = streamId
  let depth = 0
  for (let i = 0; i < MAX_WALK; i++) {
    if (currentId === conversationRoot) return depth
    const node = streams.get(currentId)
    if (!node) return 0
    if (node.parentStreamId == null) return depth
    depth++
    currentId = node.parentStreamId
  }
  return 0
}

/** The nearest ancestor stream (walking `parentStreamId`) that the conversation
 *  also occupies, or null when none is occupied. */
function nearestOccupiedAncestor(
  streamId: string,
  streams: Map<string, BranchStreamNode>,
  occupied: Set<string>
): string | null {
  let currentId = streams.get(streamId)?.parentStreamId ?? null
  for (let i = 0; i < MAX_WALK; i++) {
    if (currentId == null) return null
    if (occupied.has(currentId)) return currentId
    const node = streams.get(currentId)
    if (!node) return null
    currentId = node.parentStreamId
  }
  return null
}

/**
 * A branch conversation nested inside a parent card: the child conversation's own
 * messages rendered under a "↳ topic" header at its fork point, recursively —
 * grandchildren indent one level deeper, capped at 2; deeper collapses to a
 * "continue in panel" link (Kris dogfood ruling 2026-07-05, board-view-design.md,
 * replacing the old between-cards stub).
 */
export interface BranchConversationView {
  conversationId: string
  threadStreamId: string
  /** The parent-conversation member message this branch forks off — its placement anchor. */
  forkMessageId: string
  title: string
  /** Nesting level among branches: 1 for a direct child, 2 for a grandchild. */
  displayDepth: number
  /** This branch nests past the depth cap — render the panel link, not its subtree. */
  overflow: boolean
  /** The child conversation's own messages, resolved through the parent card's rail
   *  (already sliced to the collapsed window when the card is collapsed). */
  messages: RenderableMessage[]
  /** Locally-available branch messages hidden by the collapsed window — surfaced as
   *  an "N more replies" link into the child panel. 0 when nothing is hidden. */
  hiddenCount: number
  /** Nested grandchild branches (each `displayDepth + 1`). */
  children: BranchConversationView[]
  /** A just-sent inline sub-topic whose child conversation hasn't echoed yet:
   *  `conversationId` is the synthetic draft-panel id, so the header doesn't
   *  link. The tail still offers a reply — it queues through the idempotent
   *  sub-topic path (find-or-create thread, mint-or-attach conversation), so a
   *  slow or dropped echo never blocks continuing the branch. */
  pending?: boolean
}
