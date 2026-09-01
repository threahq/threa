import { AGENT_TOOL_NAMES, type AgentToolName } from "./constants"
import { TOOL_TIERS_BY_NAME, ToolTiers } from "./tool-tiers"

/**
 * What a tool call left behind.
 *
 * Distinct from the tier, which is about authority before the call: a tier-1
 * tool can still write durable state (`save_memo`, `schedule_follow_up`), and a
 * guarded call that the guardian denied writes nothing at all. So "was this
 * reviewed" and "did this change something" are two different claims, and only
 * the first one was visible before this existed.
 */
export const TOOL_EFFECT_KINDS = ["settings", "delegation", "subagent", "memo", "follow_up", "brief", "other"] as const
export type ToolEffectKind = (typeof TOOL_EFFECT_KINDS)[number]

export interface AgentToolEffect {
  kind: ToolEffectKind
  /**
   * Domain text supplied by the tool that made the write. Optional: the
   * fallback descriptor is synthesized without per-tool knowledge, and a
   * backend-invented stand-in would be hardcoded display text (INV-46). The
   * renderer names a label-less effect from its kind.
   */
  label?: string
  /** The field or entity touched, when there is one: `"theme"`, `"dlg_01K…"`. */
  target?: string
  /**
   * Previous and new value, for effects that replace something. Both are
   * display strings, not raw JSON — the trace renders them as a diff and can't
   * know how to format a domain value.
   */
  before?: string
  after?: string
}

/** Per-string cap. These are trace chips, and a tool can pass in a whole document. */
export const EFFECT_LABEL_MAX_CHARS = 120

/**
 * Cap on one CALL's declared effects. Named for the call, not the session: a
 * session aggregates many calls and needs its own bound, and reusing this one
 * there would silently cap a whole turn at a single call's budget.
 */
export const EFFECTS_PER_CALL_MAX = 20

/**
 * Cap on the effects a whole SESSION's lifecycle payload carries. Separate from
 * the per-call bound because a session aggregates many calls: reusing the call
 * cap here would silently truncate a busy turn at one call's budget, and this
 * one also bounds a `stream_events` JSONB payload rather than one step row.
 */
export const EFFECTS_PER_SESSION_MAX = 40

/**
 * Which tools write state the conversation does not already show.
 *
 * The rule, checkable by reading one line of a diff: **if the effect is
 * something the user would have to go somewhere else to see, it is mutating.**
 * `send_message` and `react_to_message` are excluded on purpose — they write
 * durable rows, but those rows ARE the message and the reaction, already
 * rendered in the timeline the user is looking at. Marking them would put a
 * "wrote something" badge on every ordinary reply and teach people to ignore it.
 *
 * Exhaustive via `satisfies` over `AgentToolName`, so a new tool fails to
 * compile until someone answers the question. That is the whole point: the
 * previous failure mode was a mutating tool shipping with no visibility at all
 * because nobody remembered to build it a card.
 */
export const MUTATING_TOOLS = {
  // Writes the user would have to leave this conversation to find.
  schedule_follow_up: true,
  cancel_follow_up: true,
  update_follow_up: true,
  update_stream_brief: true,
  save_memo: true,
  delegate_task: true,
  update_user_settings: true,
  // Opens a durable run + thread the user finds from the parent card, not from
  // the reply that created it.
  delegate_to_model: true,

  // Participation: durable, but rendered in place as itself.
  send_message: false,
  react_to_message: false,
  // Posts the summary as an ordinary message in the thread the user is already
  // reading and closes the run that card already shows — nothing to go find.
  report_back: false,

  // Reads.
  list_follow_ups: false,
  web_search: false,
  read_url: false,
  general_research: false,
  search_messages: false,
  search_streams: false,
  search_users: false,
  get_stream_messages: false,
  search_attachments: false,
  read_attachment: false,
  describe_memo: false,
  github_repos: false,
  github_commits: false,
  github_pulls: false,
  github_content: false,
  github_workflows: false,
  github_releases: false,
  github_issues: false,
  linear_list_issues: false,
  linear_get_issue: false,
  linear_list_projects: false,
  linear_get_project: false,
} as const satisfies Record<AgentToolName, boolean>

/**
 * Whether a tool writes state worth surfacing. Unregistered names are
 * host-local tools (the enclave's in-process readers), which are
 * conversation-local by construction and therefore not mutating.
 */
export function toolMutates(name: string): boolean {
  return name in MUTATING_TOOLS && MUTATING_TOOLS[name as AgentToolName]
}

export const MUTATING_TOOL_NAMES: readonly AgentToolName[] = AGENT_TOOL_NAMES.filter((name) => MUTATING_TOOLS[name])

function truncate(value: string): string {
  return value.length > EFFECT_LABEL_MAX_CHARS ? value.slice(0, EFFECT_LABEL_MAX_CHARS) : value
}

/**
 * The effects a completed tool call gets stamped with.
 *
 * `declared` is authoritative for its own turn whenever it is present, empty
 * included: every declaring tool catches its own failures and still returns a
 * successful result, so `[]` means "I wrote nothing" and overriding it with the
 * fallback would claim a write that did not happen. `undefined` means the tool
 * says nothing at all, and only then does the tier-free layer-0 rule apply — a
 * mutating name gets one shapeless `other` descriptor so the write is at least
 * visible.
 */
export function resolveToolEffects(toolName: string, declared: AgentToolEffect[] | undefined): AgentToolEffect[] {
  if (declared !== undefined) {
    return declared.slice(0, EFFECTS_PER_CALL_MAX).map((effect) => ({
      ...effect,
      ...(effect.label !== undefined ? { label: truncate(effect.label) } : {}),
      // `target` is bounded too: it is tool-supplied like the rest, and one
      // uncapped string defeats the per-row bound the other three enforce.
      ...(effect.target !== undefined ? { target: truncate(effect.target) } : {}),
      ...(effect.before !== undefined ? { before: truncate(effect.before) } : {}),
      ...(effect.after !== undefined ? { after: truncate(effect.after) } : {}),
    }))
  }
  return toolMutates(toolName) ? [{ kind: "other" }] : []
}

/**
 * Guarded tools that this table says write nothing — always empty.
 *
 * Tier 2 means "writes durable state outside the stream, or acts with the
 * user's authority", a strictly stronger claim than mutating, so the guarded
 * set is contained in the mutating set. Both tables are hand-maintained and can
 * drift apart silently, hence the check.
 *
 * A predicate rather than a module-load `throw`: the throw made its own guard
 * test incapable of failing (a broken table takes the import down before any
 * assertion runs), and it would have turned a mistiered tool into a crash at
 * boot for every process importing this package — backend, frontend and
 * enclave alike — instead of a red test.
 */
export function guardedToolsMissingFromMutating(): AgentToolName[] {
  return AGENT_TOOL_NAMES.filter((name) => TOOL_TIERS_BY_NAME[name] >= ToolTiers.GUARDED && !MUTATING_TOOLS[name])
}
