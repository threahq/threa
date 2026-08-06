import { ArrowUpRight, Trash2 } from "lucide-react"
import { type ActionDefinition, copyContentActions, filterVisibleActions } from "@/components/actions/action-model"
import type { DraftPreviewStatus } from "@/lib/drafts/decryption"

/** Context for a drafts-explorer row's actions. */
export interface DraftActionContext {
  /** The draft's full markdown body — the clipboard payload. */
  contentMarkdown: string
  /** Whether the body is readable (a sealed draft isn't until it decrypts). */
  contentStatus: DraftPreviewStatus
  /** Where the row opens (a stashed row's href carries `?stash=`); absent when unresolvable. */
  href?: string
  /** Restoring a stashed draft vs. opening the stream that holds the loaded one. */
  isStashed: boolean
  onDelete: () => void
}

export type DraftAction = ActionDefinition<DraftActionContext>

/**
 * A sealed draft's body is not readable until it decrypts, and a body-less
 * draft (attachments only) has nothing to put on the clipboard. Copy stays
 * visible and inert in both cases rather than disappearing as the state
 * resolves (INV-21) — and never copies a status label or an empty string.
 */
function copyUnavailable(ctx: DraftActionContext): boolean {
  return ctx.contentStatus !== "ready" || ctx.contentMarkdown.trim() === ""
}

export const draftActions: DraftAction[] = [
  {
    id: "open-draft",
    label: (ctx) => (ctx.isStashed ? "Restore draft" : "Open draft"),
    icon: ArrowUpRight,
    when: (ctx) => !!ctx.href,
    getHref: (ctx) => ctx.href,
  },
  ...copyContentActions<DraftActionContext>({
    getMarkdown: (ctx) => ctx.contentMarkdown,
    disabled: copyUnavailable,
    separatorBefore: true,
  }),
  {
    id: "delete-draft",
    label: "Delete draft",
    icon: Trash2,
    separatorBefore: true,
    variant: "destructive",
    when: () => true,
    // Opens the page's confirm dialog — the menu never deletes directly.
    action: (ctx) => ctx.onDelete(),
  },
]

export function getVisibleDraftActions(context: DraftActionContext): DraftAction[] {
  return filterVisibleActions(draftActions, context)
}
