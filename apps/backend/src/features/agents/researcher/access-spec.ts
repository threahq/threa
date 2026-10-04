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
 * - Channel: agent sees what every reader of the room can read, the room's own tree included
 * - DM: agent sees only streams all participants can access
 */
export type AgentAccessSpec =
  | { type: "user_full_access"; userId: string }
  | { type: "room_readable"; roomStreamId: string }
  | { type: "user_intersection"; userIds: [string, string] }

export interface ComputeAccessSpecParams {
  stream: Stream
  invokingUserId: string
}

/**
 * Compute the access spec for an agent based on invocation context.
 *
 * Rules:
 * - Private scratchpad: Full user access (user's scratchpads, channels, DMs, etc.);
 *   one with other members is treated like a channel
 * - Public scratchpad, channel: What every reader of the room can read
 * - DM: Intersection of all DM participants' access
 * - Thread: Inherits from root stream
 */
export async function computeAgentAccessSpec(db: Querier, params: ComputeAccessSpecParams): Promise<AgentAccessSpec> {
  const { stream, invokingUserId } = params

  // For threads, compute based on root stream
  const effectiveStream = stream.rootStreamId
    ? await StreamRepository.findById(db, stream.workspaceId, stream.rootStreamId)
    : stream

  if (!effectiveStream) {
    // Orphaned thread: no root to vet the room's readers against, so only guest_public content passes
    return { type: "room_readable", roomStreamId: stream.id }
  }

  switch (effectiveStream.type) {
    case StreamTypes.SCRATCHPAD: {
      // Public scratchpad: anyone can see, so agent only sees what every reader of the room can read
      if (effectiveStream.visibility !== Visibilities.PRIVATE) {
        return { type: "room_readable", roomStreamId: effectiveStream.id }
      }
      // Adding someone to a scratchpad's thread adds them to the scratchpad, so
      // its audience is only the invoker when no one else is a member.
      const members = await StreamMemberRepository.list(db, stream.workspaceId, { streamId: effectiveStream.id })
      return members.every((m) => m.memberId === invokingUserId)
        ? { type: "user_full_access", userId: invokingUserId }
        : { type: "room_readable", roomStreamId: effectiveStream.id }
    }

    case StreamTypes.ASIDE:
      // An aside is always private to its creator: scratchpad semantics.
      return { type: "user_full_access", userId: invokingUserId }

    case StreamTypes.DM: {
      // DM: only streams every participant can access
      const members = await StreamMemberRepository.list(db, stream.workspaceId, { streamId: effectiveStream.id })
      if (members.length !== DM_PARTICIPANT_COUNT) {
        throw new Error(
          `DM access spec requires exactly ${DM_PARTICIPANT_COUNT} members, got ${members.length} for ${effectiveStream.id}`
        )
      }
      const userIds: [string, string] = [members[0]!.memberId, members[1]!.memberId]
      return { type: "user_intersection", userIds }
    }

    default:
      return { type: "room_readable", roomStreamId: effectiveStream.id }
  }
}

/**
 * The user whose private, `user`-scoped memos (roadmap 6.4) this invocation may
 * retrieve — or `undefined` when none may be. A user-scoped memo is visible only
 * to its owner, and the researcher's output (its reply AND its broadcast trace
 * sources) reaches every participant of the invocation stream. So a private memo
 * may only be surfaced when the audience IS exactly that owner: a private
 * scratchpad (`user_full_access`). Every other context — a public/private channel
 * (`room_readable`) or a two-party DM (`user_intersection`) —
 * has additional participants, so it returns `undefined` and user-scoped memos are
 * excluded from retrieval (fail closed). Keep this the single source of truth for
 * "may this invocation read the invoking user's private tier".
 */
export function resolveMemoViewer(spec: AgentAccessSpec): string | undefined {
  return spec.type === "user_full_access" ? spec.userId : undefined
}

/**
 * Options for getting accessible streams.
 */
export interface GetAccessibleStreamsOptions {
  streamTypes?: StreamType[]
}
