import { AgentTriggers, type AgentSessionRerunContext } from "@threahq/types"

/**
 * Why a persona turn is running. One first-class answer replaces the four
 * orthogonal optional signals that used to accumulate on `PersonaAgentInput`
 * (`trigger`, `supersedesSessionId`, `rerunContext`, `followUpId`), each with
 * scattered if-branches, a bespoke prompt section, and repurposed runtime
 * flags (roadmap 1.5). Adding an invocation kind = one union member + its
 * prompt block, not another optional field.
 *
 * The kinds are mutually exclusive at every enqueue site: a mention sets only
 * `trigger`, a supersede rerun only `supersedesSessionId`/`rerunContext`, a
 * fired follow-up only `followUpId`, and companion catch-up none of them.
 */
export type TurnPurpose =
  | { kind: "catch_up" }
  | { kind: "mention" }
  | { kind: "follow_up"; followUpId: string }
  | { kind: "supersede_rerun"; supersedesSessionId: string; rerunContext?: AgentSessionRerunContext }
  // A companion turn in a persona editor's test-drive scratchpad (roadmap 7.1):
  // the precheck loads `draftId` and runs the candidate config instead of the
  // saved override. Behaviourally identical to `catch_up` otherwise — no prompt
  // section (the draft prompt must run verbatim), default flags.
  | { kind: "draft_test"; draftId: string }
  // The first turn of a subagent run: the persona wakes up in a fresh thread,
  // bound to the delegated model, with the brief as its only instruction. No
  // trigger message exists (`messageId` is synthetic), so without this kind the
  // turn would run as a context-less catch-up in an empty stream.
  | { kind: "subagent_kickoff"; subagentRunId: string }

export type TurnPurposeKind = TurnPurpose["kind"]

/**
 * Map an in-flight queue payload to the turn's purpose at the worker boundary.
 * The wire payload keeps its original fields (rows already enqueued must still
 * decode), so the union is derived here rather than carried on the job.
 *
 * Precedence matches how the enqueue sites are wired — the fields never co-occur,
 * so any order that keeps the four kinds distinct is equivalent; this one reads
 * most-specific first.
 */
export function resolveTurnPurpose(payload: {
  trigger?: typeof AgentTriggers.MENTION
  supersedesSessionId?: string
  rerunContext?: AgentSessionRerunContext
  followUpId?: string
  personaDraftId?: string
  subagentRunId?: string
}): TurnPurpose {
  // Highest precedence: a kickoff job carries no other purpose field, and its
  // synthetic messageId would otherwise decode as a plain catch-up.
  if (payload.subagentRunId) {
    return { kind: "subagent_kickoff", subagentRunId: payload.subagentRunId }
  }
  if (payload.followUpId) {
    return { kind: "follow_up", followUpId: payload.followUpId }
  }
  if (payload.supersedesSessionId) {
    return {
      kind: "supersede_rerun",
      supersedesSessionId: payload.supersedesSessionId,
      rerunContext: payload.rerunContext,
    }
  }
  // Above mention/catch_up, below follow_up/supersede: a follow-up firing or a
  // supersede rerun in a test stream is still that first-class thing; a plain
  // companion message in a test stream runs the draft. The fields never co-occur
  // at the companion enqueue site (it sets only `personaDraftId`).
  if (payload.personaDraftId) {
    return { kind: "draft_test", draftId: payload.personaDraftId }
  }
  if (payload.trigger === AgentTriggers.MENTION) {
    return { kind: "mention" }
  }
  return { kind: "catch_up" }
}

/**
 * Runtime flags derived from the purpose kind — never set ad hoc at the turn
 * request. `allowNoMessageOutput` exposes `keep_response` so a turn can end
 * silently instead of the runtime auto-committing filler; supersede reruns and
 * fired follow-ups both legitimately conclude "nothing to add", plain catch-up
 * and mention turns do not.
 *
 * The caller passes the *effective* purpose: a supersede rerun whose target
 * session vanished, or a follow-up whose row failed to load, degrades to
 * `catch_up` before this runs, so the flag tracks the behavior actually taken.
 */
export function deriveTurnFlags(purpose: TurnPurpose): { allowNoMessageOutput: boolean } {
  return {
    allowNoMessageOutput: purpose.kind === "supersede_rerun" || purpose.kind === "follow_up",
  }
}
