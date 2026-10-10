import { useMemo } from "react"
import { WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import { isDraftId, useFeatureFlag } from "@/hooks"
import { useViewerPermissions } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { useCanManageChannels } from "@/lib/use-can-manage-channels"
import { isToleranceMatch, rankMatchesScored } from "@/lib/match-score"
import { commands, paneCommands, type Command, type CommandContext } from "./commands"
import { draftStreamCommands, streamCommands } from "./stream-commands"
import type { ModeResult, QuickSwitcherItem } from "./types"

interface UseCommandItemsParams {
  query: string
  commandContext: CommandContext
}

/**
 * Filter and rank palette commands for a query. The visible label is the
 * primary match target; id and keywords are hidden aliases scored a tier
 * below, so a command whose label matches always outranks one that only
 * matches on an alias, regardless of definition order. Ties keep the curated
 * array order.
 */
function rankCommandsScored(candidates: Command[], query: string) {
  return rankMatchesScored(candidates, query, (command) => ({
    labels: [command.label],
    keywords: [command.id, ...(command.keywords ?? [])],
  }))
}

/**
 * Rank the palette's groups against each other before they are concatenated.
 * Groups render in section order rather than by score, so the first row of the
 * first group is what Enter fires — and a guessed match there would beat an
 * exact one below it. Typo and fuzzy matches are therefore dropped from every
 * group as soon as any group holds a real one: on a draft scratchpad,
 * `> drafts` offered a guessed "Delete this draft" above "View Drafts".
 */
export function rankGroups(query: string, groups: readonly Command[][]): Command[][] {
  const scored = groups.map((group) => rankCommandsScored(group, query))
  const hasRealMatch = scored.some((group) => group.some((entry) => !isToleranceMatch(entry.score)))
  if (!hasRealMatch) return scored.map((group) => group.map((entry) => entry.item))
  return scored.map((group) => group.filter((entry) => !isToleranceMatch(entry.score)).map((entry) => entry.item))
}

export function useCommandItems({ query, commandContext }: UseCommandItemsParams): ModeResult {
  // AI Agents settings is admin-only (the tab itself is admin-gated), so the
  // command hides for non-admins rather than opening settings to a fallback tab.
  const viewerPermissions = useViewerPermissions(commandContext.workspaceId)
  const isAdmin = hasPermission(viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const canManageChannels = useCanManageChannels(commandContext.workspaceId)
  // The Diagnostics settings tab is rollout-gated; without the same gate here
  // the command opens Settings to a tab that isn't there.
  const perfDiagnostics = useFeatureFlag(commandContext.workspaceId, "perfDiagnostics")
  const items = useMemo(() => {
    const { currentStreamId, currentStreamName } = commandContext

    const toItem = (command: Command, group: string): QuickSwitcherItem => ({
      id: command.id,
      label: command.label,
      icon: command.icon,
      group,
      onSelect: () => {
        command.action(commandContext)
      },
    })

    // Contextual commands act on the stream in view. The section header names
    // the stream so it stays clear these are stream-specific even while the
    // list is filtered down by a query. Draft scratchpads have no server-side
    // settings/files/labels, so they only get a delete command.
    let contextualCommands: Command[] = []
    if (currentStreamId) {
      contextualCommands = isDraftId(currentStreamId) ? draftStreamCommands : streamCommands
      contextualCommands = contextualCommands.filter(
        (c) =>
          (c.id !== "stream-archive" || commandContext.currentStreamArchived === false) &&
          (c.id !== "stream-unarchive" || commandContext.currentStreamArchived === true) &&
          (c.id !== "stream-open-aside" || !!commandContext.openAside) &&
          (c.id !== "stream-settle" || !!commandContext.settleStream)
      )
    }
    const contextualGroup = currentStreamName ? `This stream — ${currentStreamName}` : "This stream"
    const shownPaneCommands = paneCommands.filter(
      (c) =>
        (c.id !== "pane-close" || !!commandContext.closePane) &&
        (c.id !== "pane-close-others" || !!commandContext.closeOtherPanes) &&
        (c.id !== "pane-close-all" || !!commandContext.closeAllPanes)
    )
    // Groups render in section order, not by score, so they are ranked
    // together (see rankGroups) and only ordered within a section afterwards.
    const globalCommands = commands.filter(
      (c) =>
        (c.id !== "open-ai-agents" || isAdmin) &&
        (c.id !== "new-channel" || canManageChannels) &&
        (c.id !== "settings-diagnostics" || perfDiagnostics === "available")
    )
    const [rankedContextual, rankedPanes, rankedGlobal] = rankGroups(query, [
      contextualCommands,
      shownPaneCommands,
      globalCommands,
    ])
    const contextualItems = rankedContextual.map((c) => toItem(c, contextualGroup))
    const paneItems = rankedPanes.map((c) => toItem(c, "Panes"))

    const globalItems = rankedGlobal.map((c) => toItem(c, "Commands"))

    return [...contextualItems, ...paneItems, ...globalItems]
  }, [query, commandContext, isAdmin, canManageChannels, perfDiagnostics])

  return {
    items,
    emptyMessage: "No commands found.",
  }
}
