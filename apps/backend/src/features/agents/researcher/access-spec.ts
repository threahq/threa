import type { Querier } from "../../../db"
import type { StreamType } from "@threahq/types"
import { DM_PARTICIPANT_COUNT, StreamTypes, Visibilities } from "@threahq/types"
import { StreamRepository, type Stream } from "../../streams"
import { StreamMemberRepository } from "../../streams"

/**
 * Specifies what streams an agent can access based on invocation context.
 *
 * This is different from user access - agent access depends on WHERE the agent
 * was invoked, not just WHO invoked it.
 *
 * Examples:
 * - Private scratchpad: agent sees everything the user can see
 * - Public channel: agent sees only public content
 * - DM: agent sees only streams all participants can access
 * - Private channel: agent sees public content + current channel
 */
export type AgentAccessSpec =
  | { type: "user_full_access"; userId: string }
  | { type: "public_only" }
  | { type: "public_plus_stream"; streamId: string }
  | { type: "user_intersection"; userIds: [string, string] }

export interface ComputeAccessSpecParams {
  stream: Stream
  invokingUserId: string
}

/**
 * Compute the access spec for an agent based on invocation context.
 *
 * Rules:
 * - Private scratchpad: Full user access (user's scratchpads, channels, DMs, etc.)
 * - Public scratchpad: Only public streams
 * - Private channel: Public streams + this channel (and its threads)
 * - Public channel: Only public streams
 * - DM: Intersection of all DM participants' access
 * - Thread: Inherits from root stream
 */
export async function computeAgentAccessSpec(db: Querier, params: ComputeAccessSpecParams): Promise<AgentAccessSpec> {
  const { stream, invokingUserId } = params

  // For threads, compute based on root stream
  const effectiveStream = stream.rootStreamId ? await StreamRepository.findById(db, stream.rootStreamId) : stream

  if (!effectiveStream) {
    // Orphaned thread - fall back to public only
    return { type: "public_only" }
  }

  switch (effectiveStream.type) {
    case StreamTypes.SCRATCHPAD:
      // Private scratchpad: user sees everything they can access
      // Public scratchpad: anyone can see, so agent only sees public
      return effectiveStream.visibility === Visibilities.PRIVATE
        ? { type: "user_full_access", userId: invokingUserId }
        : { type: "public_only" }

    case StreamTypes.ASIDE:
      // An aside is always private to its creator: scratchpad semantics.
      return { type: "user_full_access", userId: invokingUserId }

    case StreamTypes.CHANNEL:
      // Private channel: public streams + this channel
      // Public channel: only public streams
      return effectiveStream.visibility === Visibilities.PRIVATE
        ? { type: "public_plus_stream", streamId: effectiveStream.id }
        : { type: "public_only" }

    case StreamTypes.DM: {
      // DM: only streams every participant can access
      const members = await StreamMemberRepository.list(db, { streamId: effectiveStream.id })
      if (members.length !== DM_PARTICIPANT_COUNT) {
        throw new Error(
          `DM access spec requires exactly ${DM_PARTICIPANT_COUNT} members, got ${members.length} for ${effectiveStream.id}`
        )
      }
      const userIds: [string, string] = [members[0]!.memberId, members[1]!.memberId]
      return { type: "user_intersection", userIds }
    }

    default:
      return { type: "public_only" }
  }
}

/**
 * The user whose private, `user`-scoped memos (roadmap 6.4) this invocation may
 * retrieve — or `undefined` when none may be. A user-scoped memo is visible only
 * to its owner, and the researcher's output (its reply AND its broadcast trace
 * sources) reaches every participant of the invocation stream. So a private memo
 * may only be surfaced when the audience IS exactly that owner: a private
 * scratchpad (`user_full_access`). Every other context — a public/private channel
 * (`public_only`/`public_plus_stream`) or a two-party DM (`user_intersection`) —
 * has additional participants, so it returns `undefined` and user-scoped memos are
 * excluded from retrieval (fail closed). Keep this the single source of truth for
 * "may this invocation read the invoking user's private tier".
 */
export function resolveMemoViewer(spec: AgentAccessSpec): string | undefined {
  return spec.type === "user_full_access" ? spec.userId : undefined
}

/**
 * Get a human-readable description of the access spec for debugging.
 */
export function describeAccessSpec(spec: AgentAccessSpec): string {
  switch (spec.type) {
    case "user_full_access":
      return `full access for user ${spec.userId}`
    case "public_only":
      return "public streams only"
    case "public_plus_stream":
      return `public streams + stream ${spec.streamId}`
    case "user_intersection":
      return `intersection of ${spec.userIds.length} users' access`
  }
}

/**
 * Options for getting accessible streams.
 */
export interface GetAccessibleStreamsOptions {
  streamTypes?: StreamType[]
}
