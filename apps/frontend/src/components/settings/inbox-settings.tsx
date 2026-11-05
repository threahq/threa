import { useState } from "react"
import { useParams } from "react-router-dom"
import { usePreferences } from "@/contexts"
import { useBoardHome, useBoardViews } from "@/hooks/use-board-views"
import { summarizeBoardView } from "@/components/board/board-saved-views"
import { parseLensParam } from "@/components/board/board-filter-params"
import { BOARD_LENS_DEFS } from "@/lib/board/lens-defs"
import {
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX,
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN,
  BOARD_FULL_TAIL_COUNT_MAX,
  BOARD_FULL_TAIL_COUNT_MIN,
  BOARD_LEAD_LINE_LENGTH_MAX,
  BOARD_LEAD_LINE_LENGTH_MIN,
  BOARD_LEDGER_ROWS_MAX,
  BOARD_LEDGER_ROWS_MIN,
  BOARD_LENSES,
  BOARD_MASS_BADGE_MODES,
  DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT,
  DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT,
  DEFAULT_BOARD_FULL_TAIL_COUNT,
  DEFAULT_BOARD_LEAD_LINE_LENGTH,
  DEFAULT_BOARD_LEDGER_ROWS,
  INBOX_CLEAR_MODE_OPTIONS,
  LABEL_REMOVE_ON_MOVE_OPTIONS,
  UNREAD_OPEN_POSITION_OPTIONS,
  normalizeBoardMassBadge,
  type BoardLens,
  type BoardMassBadge,
  type InboxClearMode,
  type LabelRemoveOnMove,
  type UnreadOpenPosition,
} from "@threahq/types"
import { FoldPreview } from "./fold-preview"
import {
  ChoiceSetting,
  FOLD_AT_HEIGHT,
  FoldSetting,
  NumberSetting,
  SettingsDisclosure,
  SettingsSection,
  type ChoiceOption,
} from "./setting-primitives"
import type { SettingId } from "./settings-registry"

type Choices<T extends string> = Record<T, Omit<ChoiceOption<T>, "value">>

function options<T extends string>(values: readonly T[], choices: Choices<T>): ChoiceOption<T>[] {
  return values.map((value) => ({ value, ...choices[value] }))
}

export const UNREAD_OPEN_CHOICES: Choices<UnreadOpenPosition> = {
  latest: { label: "At the latest message", description: "Messages you missed are above." },
  marker: { label: "At your first unread", description: "Read what you missed in order." },
}

export const INBOX_CLEAR_CHOICES: Choices<InboxClearMode> = {
  interaction: {
    label: "When you reply or react",
    description: "Reading alone keeps a stream in the Inbox.",
  },
  manual: { label: "Only when you settle it", description: "Reading or replying keeps a stream in the Inbox." },
  read: { label: "As soon as you read it", description: "The Inbox shows only streams with unreads." },
}

const LABEL_REMOVE_CHOICES: Choices<LabelRemoveOnMove> = {
  ask: { label: "Ask each time" },
  always: { label: "Remove the old label" },
  never: { label: "Keep the old label" },
}

const LEDGER_SETTINGS: readonly SettingId[] = [
  "board-full-tail",
  "board-ledger-rows",
  "board-lead-line",
  "board-head-badge",
]

const BOARD_MASS_BADGE_CHOICES: Record<BoardMassBadge, string> = {
  count: "Unread count",
  off: "None",
}

/**
 * Board home: the lens or saved view the bare `/board` lands on. Selecting a lens
 * clears any saved-view home (so the landing actually lands there); selecting a
 * view leaves the lens as the fallback for a stale/deleted view. Mirrors the pins
 * in the board's own lens menu.
 */
function BoardHomeSetting({ workspaceId }: { workspaceId: string }) {
  const { preferences, updatePreferences } = usePreferences()
  const { data: views } = useBoardViews(workspaceId)
  const boardDefaultLens = parseLensParam(preferences?.boardDefaultLens ?? null)
  // The resolved home view's id, or null when the home is a lens (or the stored id
  // no longer resolves) — land on the lens then.
  const activeViewId = useBoardHome(workspaceId).view?.id ?? null
  const value = activeViewId ? `view:${activeViewId}` : `lens:${boardDefaultLens}`

  const choices: ChoiceOption<string>[] = [
    ...BOARD_LENSES.map((lens) => ({
      value: `lens:${lens}`,
      label: BOARD_LENS_DEFS[lens].label,
      description: BOARD_LENS_DEFS[lens].description,
    })),
    ...(views ?? []).map((view) => ({
      value: `view:${view.id}`,
      label: `${view.name} (saved view)`,
      description: summarizeBoardView(view),
    })),
  ]

  return (
    <ChoiceSetting
      setting="board-home"
      variant="select"
      optionDescriptionsInMenu
      value={value}
      options={choices}
      onValueChange={(next) => {
        if (next.startsWith("view:")) void updatePreferences({ boardDefaultViewId: next.slice("view:".length) })
        else
          void updatePreferences({
            boardDefaultLens: next.slice("lens:".length) as BoardLens,
            boardDefaultViewId: null,
          })
      }}
    />
  )
}

export function OpeningStreamsSettings() {
  const { preferences, updatePreference } = usePreferences()
  return (
    <SettingsSection section="opening">
      <ChoiceSetting
        setting="unread-landing"
        variant="select"
        value={preferences?.unreadOpenPosition ?? "latest"}
        options={options(UNREAD_OPEN_POSITION_OPTIONS, UNREAD_OPEN_CHOICES)}
        onValueChange={(value) => updatePreference("unreadOpenPosition", value)}
      />
    </SettingsSection>
  )
}

export function InboxSettings() {
  const { preferences, updatePreference } = usePreferences()

  return (
    <div className="space-y-8">
      <SettingsSection section="inbox-settling">
        <ChoiceSetting
          setting="settling"
          variant="select"
          value={preferences?.inboxClearMode ?? "interaction"}
          options={options(INBOX_CLEAR_MODE_OPTIONS, INBOX_CLEAR_CHOICES)}
          onValueChange={(value) => updatePreference("inboxClearMode", value)}
        />
      </SettingsSection>

      <SettingsSection section="labels">
        <ChoiceSetting
          setting="label-move"
          value={preferences?.labelRemoveOnMove ?? "ask"}
          options={options(LABEL_REMOVE_ON_MOVE_OPTIONS, LABEL_REMOVE_CHOICES)}
          variant="select"
          onValueChange={(value) => updatePreference("labelRemoveOnMove", value)}
        />
      </SettingsSection>
    </div>
  )
}

export function BoardSettings() {
  const { preferences, updatePreference, updatePreferences } = usePreferences()
  const { workspaceId } = useParams<{ workspaceId: string }>()

  const boardCardCollapseEnabled = preferences?.boardCardCollapseEnabled ?? false
  const boardCardCollapseAtHeight = preferences?.boardCardCollapseAtHeight ?? DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT
  const boardCardCollapseToHeight = preferences?.boardCardCollapseToHeight ?? DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT
  const fullTail = preferences?.boardFullTailCount ?? DEFAULT_BOARD_FULL_TAIL_COUNT
  const ledgerRows = preferences?.boardLedgerRows ?? DEFAULT_BOARD_LEDGER_ROWS
  const leadLine = preferences?.boardLeadLineLength ?? DEFAULT_BOARD_LEAD_LINE_LENGTH
  const [draftTo, setDraftTo] = useState<number | null>(null)

  return (
    <SettingsSection section="board">
      {workspaceId && <BoardHomeSetting workspaceId={workspaceId} />}
      <FoldSetting
        setting="board-card-collapse"
        atSetting="board-card-collapse-at"
        noun={{ one: "card", many: "cards" }}
        choice={boardCardCollapseEnabled ? FOLD_AT_HEIGHT : "never"}
        onChoiceChange={(choice) => void updatePreference("boardCardCollapseEnabled", choice === FOLD_AT_HEIGHT)}
        value={boardCardCollapseAtHeight}
        min={BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN}
        max={BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX}
        unit="px"
        // A collapsed card can't be taller than the height that collapses it.
        onCommit={(atHeight) =>
          void updatePreferences({
            boardCardCollapseEnabled: true,
            boardCardCollapseAtHeight: atHeight,
            boardCardCollapseToHeight: Math.min(boardCardCollapseToHeight, atHeight),
          })
        }
      >
        <NumberSetting
          setting="board-card-collapse-to"
          value={boardCardCollapseToHeight}
          min={BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN}
          max={Math.min(BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX, boardCardCollapseAtHeight)}
          unit="px"
          onDraftChange={setDraftTo}
          onCommit={(toHeight) => void updatePreference("boardCardCollapseToHeight", toHeight)}
        >
          {boardCardCollapseEnabled && <FoldPreview foldTo={draftTo ?? boardCardCollapseToHeight} />}
        </NumberSetting>
      </FoldSetting>
      <SettingsDisclosure
        label="Older messages on cards"
        settings={LEDGER_SETTINGS}
        summary={`${fullTail} newest in full, then ${ledgerRows} one-line summaries of up to ${leadLine} characters`}
      >
        <NumberSetting
          setting="board-full-tail"
          value={fullTail}
          min={BOARD_FULL_TAIL_COUNT_MIN}
          max={BOARD_FULL_TAIL_COUNT_MAX}
          unit="messages"
          onCommit={(count) => void updatePreference("boardFullTailCount", count)}
        />
        <NumberSetting
          setting="board-ledger-rows"
          value={ledgerRows}
          min={BOARD_LEDGER_ROWS_MIN}
          max={BOARD_LEDGER_ROWS_MAX}
          unit="rows"
          onCommit={(rows) => void updatePreference("boardLedgerRows", rows)}
        />
        <NumberSetting
          setting="board-lead-line"
          value={leadLine}
          min={BOARD_LEAD_LINE_LENGTH_MIN}
          max={BOARD_LEAD_LINE_LENGTH_MAX}
          unit="characters"
          onCommit={(length) => void updatePreference("boardLeadLineLength", length)}
        />
        <ChoiceSetting
          setting="board-head-badge"
          value={normalizeBoardMassBadge(preferences?.boardMassBadge)}
          options={BOARD_MASS_BADGE_MODES.map((value) => ({ value, label: BOARD_MASS_BADGE_CHOICES[value] }))}
          onValueChange={(value) => updatePreference("boardMassBadge", value)}
        />
      </SettingsDisclosure>
    </SettingsSection>
  )
}
