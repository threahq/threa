import type { ComponentType } from "react"
import { FileText, Type } from "lucide-react"
import { toast } from "sonner"
import { stripMarkdown } from "@/lib/markdown"

/**
 * The context-generic action model behind every row context menu (message rows,
 * drafts-explorer rows). `messageActions` was the original and only shape; the
 * type parameter is the seam that lets another surface declare its own context
 * without inheriting message fields, while both render through the same
 * dropdown/drawer components.
 */
export interface ActionDefinition<Context> {
  id: string
  /** Visible label — a function when it depends on the row. */
  label: string | ((context: Context) => string)
  icon: ComponentType<{ className?: string }>
  /**
   * Render a separator before this action. For grouped entries (see
   * {@link ActionDefinition.groupId}), only the group's primary action's
   * `separatorBefore` is honored — alternatives ride along the group.
   */
  separatorBefore?: boolean
  /** Visual variant — "destructive" renders in red */
  variant?: "destructive"
  /**
   * Group id for split-button grouping. Adjacent visible actions sharing the
   * same `groupId` collapse into one row: the first is the primary (default
   * tap), the rest become alternatives behind a chevron.
   */
  groupId?: string
  /** Controls visibility — evaluated by {@link filterVisibleActions} */
  when: (context: Context) => boolean
  /**
   * Renders the entry inert. Distinct from `when`: use it when the action
   * belongs on this row but cannot run right now (a sealed draft's body isn't
   * readable yet), so the affordance stays visible instead of the menu
   * changing shape as state resolves (INV-21).
   */
  disabled?: (context: Context) => boolean
  /** URL for navigation actions — rendered as <Link> (INV-40) */
  getHref?: (context: Context) => string | undefined
  /** Handler for mutation actions — rendered as <button> */
  action?: (context: Context) => void | Promise<void>
}

/**
 * A grouped item in the rendered menu.
 *
 * - `single` — an ungrouped action (or a group whose only visible member
 *   degraded to a standalone row).
 * - `group` — multiple visible same-`groupId` actions. The renderer shows
 *   `members[0]` as the row's primary tap target and exposes ALL members in a
 *   chevron-driven dropdown, so the menu reads as a complete list with the
 *   default pre-highlighted.
 */
export type GroupedAction<Context> =
  | { kind: "single"; action: ActionDefinition<Context> }
  | { kind: "group"; members: ActionDefinition<Context>[] }

/** Resolve the visible label for an action, handling the string/function variants. */
export function resolveActionLabel<Context>(action: ActionDefinition<Context>, context: Context): string {
  return typeof action.label === "function" ? action.label(context) : action.label
}

/** Filter actions that should be shown for a given context. */
export function filterVisibleActions<Context>(
  actions: ActionDefinition<Context>[],
  context: Context
): ActionDefinition<Context>[] {
  return actions.filter((action) => action.when(context))
}

/**
 * Collapse adjacent same-`groupId` actions into split-button groups, leaving
 * ungrouped actions as `single` items. Order is preserved; grouped items appear
 * at the position of their first member. A group with only one visible member
 * degrades to a `single` item — no chevron.
 */
export function groupVisibleActions<Context>(actions: ActionDefinition<Context>[]): GroupedAction<Context>[] {
  const items: GroupedAction<Context>[] = []
  let i = 0
  while (i < actions.length) {
    const action = actions[i]
    if (!action.groupId) {
      items.push({ kind: "single", action })
      i++
      continue
    }

    const members: ActionDefinition<Context>[] = [action]
    let j = i + 1
    while (j < actions.length && actions[j].groupId === action.groupId) {
      members.push(actions[j])
      j++
    }
    if (members.length === 1) {
      items.push({ kind: "single", action })
    } else {
      items.push({ kind: "group", members })
    }
    i = j
  }
  return items
}

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

/**
 * The Copy as Markdown / Copy as Plain text pair — one definition shared by
 * every surface that offers it, so labels, order, group and the INV-63-allow'd
 * toasts can't drift between the timeline and the drafts explorer.
 */
export function copyContentActions<Context>(options: {
  /** The markdown to copy for this row. */
  getMarkdown: (context: Context) => string
  when?: (context: Context) => boolean
  disabled?: (context: Context) => boolean
  separatorBefore?: boolean
}): ActionDefinition<Context>[] {
  const when = options.when ?? (() => true)
  return [
    {
      id: "copy-as-markdown",
      label: "Copy as Markdown",
      icon: FileText,
      separatorBefore: options.separatorBefore,
      groupId: "copy",
      when,
      disabled: options.disabled,
      action: async (context) => {
        try {
          await copyToClipboard(options.getMarkdown(context))
          toast.success("Copied as Markdown") // INV-63-allow: clipboard copy from a closing menu has no inline anchor
        } catch {
          toast.error("Failed to copy")
        }
      },
    },
    {
      id: "copy-as-plain-text",
      label: "Copy as Plain text",
      icon: Type,
      groupId: "copy",
      when,
      disabled: options.disabled,
      action: async (context) => {
        try {
          await copyToClipboard(stripMarkdown(options.getMarkdown(context)))
          toast.success("Copied as plain text") // INV-63-allow: clipboard copy from a closing menu has no inline anchor
        } catch {
          toast.error("Failed to copy")
        }
      },
    },
  ]
}
