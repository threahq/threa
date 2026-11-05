import { useMemo } from "react"
import { StreamTypes } from "@threahq/types"
import { isDraftId } from "@/hooks"
import { useCanManageChannels } from "@/lib/use-can-manage-channels"
import { isToleranceMatch, rankMatchesScored, scoreMatch } from "@/lib/match-score"
import { useSettingsVisibility } from "@/components/settings/use-settings-visibility"
import { commands, paneCommands, type Command, type CommandContext } from "./commands"
import { draftStreamCommands, streamCommands } from "./stream-commands"
import type { ModeResult, QuickSwitcherItem } from "./types"
import { useSettingItems } from "./use-setting-items"

/** A doc's body is its editor: no composer for a snippet, no settings or agent agenda of its own. */
const TIMELINE_STREAM_COMMAND_IDS = new Set(["stream-create-snippet", "stream-settings", "stream-agenda"])
const MAX_SETTING_ITEMS = 5

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

function labelMatches(query: string, label: string): boolean {
  const score = scoreMatch(query, [label])
  return score !== Infinity && !isToleranceMatch(score)
}

/**
 * Settings follow the commands, unless a setting's own name matches and no
 * command's does: then the commands only matched an alias, and `> theme`
 * opens Theme rather than a page that lists "theme" among its keywords.
 */
function settingsLead(query: string, commandLabels: readonly string[], settingLabels: readonly string[]) {
  return (
    settingLabels.some((label) => labelMatches(query, label)) &&
    !commandLabels.some((label) => labelMatches(query, label))
  )
}

export function useCommandItems({ query, commandContext }: UseCommandItemsParams): ModeResult {
  const canManageChannels = useCanManageChannels(commandContext.workspaceId)
  // Settings pages this viewer can't see (admin-only) stay out of the palette
  // rather than opening the window on a fallback.
  const settingsVisibility = useSettingsVisibility(commandContext.workspaceId)
  const settingItems = useSettingItems({
    workspaceId: commandContext.workspaceId,
    query,
    currentStreamId: commandContext.currentStreamId,
    limit: MAX_SETTING_ITEMS,
    closeDialog: commandContext.closeDialog,
    openSettings: commandContext.openSettings,
    openStreamSettings: commandContext.openStreamSettings,
  })
  const items = useMemo(() => {
    const { currentStreamId, currentStreamName } = commandContext

    const toItem = (command: Command, group: string): QuickSwitcherItem => ({
      id: command.id,
      label: command.label,
      icon: command.icon,
      group,
      href: command.path && `/w/${commandContext.workspaceId}${command.path}`,
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
      const isDoc = commandContext.currentStreamType === StreamTypes.DOC
      contextualCommands = isDraftId(currentStreamId) ? draftStreamCommands : streamCommands
      contextualCommands = contextualCommands.filter(
        (c) =>
          (!isDoc || !TIMELINE_STREAM_COMMAND_IDS.has(c.id)) &&
          (c.id !== "stream-archive" || commandContext.currentStreamArchived === false) &&
          (c.id !== "stream-unarchive" || commandContext.currentStreamArchived === true) &&
          (c.id !== "stream-open-aside" || !!commandContext.openAside) &&
          (c.id !== "stream-members" || !!commandContext.openStreamMembers) &&
          (c.id !== "stream-new-doc" || !!commandContext.createDoc) &&
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
        (!c.id.startsWith("settings-") || settingsVisibility.tabs.some((tab) => c.id === `settings-${tab}`)) &&
        (c.id !== "new-channel" || canManageChannels) &&
        (c.id !== "new-doc" || !!commandContext.createTopLevelDoc)
    )
    const [rankedContextual, rankedPanes, rankedGlobal] = rankGroups(query, [
      contextualCommands,
      shownPaneCommands,
      globalCommands,
    ])
    const contextualItems = rankedContextual.map((c) => toItem(c, contextualGroup))
    const paneItems = rankedPanes.map((c) => toItem(c, "Panes"))

    const globalItems = rankedGlobal.map((c) => toItem(c, "Commands"))

    const commandItems = [...contextualItems, ...paneItems, ...globalItems]
    const lead = settingsLead(
      query,
      commandItems.map((item) => item.label),
      settingItems.map((item) => item.label)
    )
    return lead ? [...settingItems, ...commandItems] : [...commandItems, ...settingItems]
  }, [query, commandContext, canManageChannels, settingsVisibility, settingItems])

  return {
    items,
    emptyMessage: "No commands found.",
  }
}
