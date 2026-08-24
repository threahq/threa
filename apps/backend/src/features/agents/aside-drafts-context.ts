import { asideDraftScopePrefix } from "@threa/types"
import type { Querier } from "../../db"
import { DraftsRepository, type Draft } from "../drafts"

/**
 * How many of an aside's drafts reach the prompt. An aside is a private
 * thinking surface with a handful of drafts in its dock; the cap is a prompt
 * bound for a pathological dock, not pagination — most recently edited win.
 */
export const ASIDE_DRAFT_CONTEXT_LIMIT = 10

/**
 * Per-draft character budget. A long draft is exactly the thing the user wants
 * read, so this is generous; past it the tail is cut and the cut is stated, so
 * the model never reviews half a draft believing it saw all of it (INV-11).
 */
export const ASIDE_DRAFT_CONTEXT_MAX_CHARS = 12_000

/**
 * The drafts open in an aside, rendered for the agent's volatile prompt region.
 *
 * The aside's drafts ARE the aside — the dock is its point — so they are not a
 * context ref the client attaches: every turn reads the current rows. That also
 * means an aside opened with nothing on screen (no bag at all) still has its
 * drafts read.
 *
 * Volatile, never the stable prefix: the user edits between turns, and a body
 * that changes would break the cached prefix it sat in.
 */
export async function renderAsideDrafts(
  db: Querier,
  params: { workspaceId: string; asideId: string; ownerId: string }
): Promise<string | null> {
  const drafts = await DraftsRepository.listByScopePrefix(db, {
    workspaceId: params.workspaceId,
    userId: params.ownerId,
    scopePrefix: asideDraftScopePrefix(params.asideId),
    limit: ASIDE_DRAFT_CONTEXT_LIMIT,
  })
  return renderAsideDraftSection(drafts)
}

/** Pure render half, so the formatting is testable without a database. */
export function renderAsideDraftSection(drafts: Draft[]): string | null {
  const readable = drafts.filter((draft) => (draft.contentMarkdown ?? "").trim().length > 0)
  // A draft the user is writing under end-to-end encryption reaches the server
  // as ciphertext only. Saying so beats an agent that reports an empty dock.
  const sealed = drafts.filter(
    (draft) => draft.ciphertext !== null && (draft.contentMarkdown ?? "").trim().length === 0
  ).length
  if (readable.length === 0 && sealed === 0) return null

  const parts: string[] = [
    "## Drafts open in this aside",
    "",
    "The user's own work in progress, as it stands right now — this section is re-read every",
    "turn, so it reflects their latest edits and may catch a sentence mid-word. It is what they",
    'mean by "my draft". Critique it, quote from it, and suggest replacements; never repeat it',
    'back wholesale. Your suggestions land in it through the user\'s "Insert into draft" action,',
    "so write them as text they can drop in.",
  ]

  for (const draft of readable) {
    const body = draft.contentMarkdown ?? ""
    const truncated = body.length > ASIDE_DRAFT_CONTEXT_MAX_CHARS
    const shown = truncated ? body.slice(0, ASIDE_DRAFT_CONTEXT_MAX_CHARS) : body
    const attachments =
      draft.attachmentIds.length > 0
        ? ` · ${draft.attachmentIds.length} attachment${draft.attachmentIds.length === 1 ? "" : "s"}`
        : ""
    parts.push("", `### Draft (last edited ${draft.clientUpdatedAt.toISOString()}${attachments})`, "", shown.trimEnd())
    if (truncated) {
      parts.push(
        "",
        `(cut off here at ${ASIDE_DRAFT_CONTEXT_MAX_CHARS} characters — the draft continues beyond what you can see; say so before judging its ending.)`
      )
    }
  }

  if (sealed > 0) {
    parts.push(
      "",
      `(${sealed} more draft${sealed === 1 ? " is" : "s are"} end-to-end encrypted, so its text never reaches you. Ask the user to paste what they want read.)`
    )
  }

  return parts.join("\n")
}
