import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { X } from "lucide-react"
import { usePreferences } from "@/contexts"
import { useBoardHome, useBoardViews } from "@/hooks/use-board-views"
import { summarizeBoardView } from "@/components/board/board-saved-views"
import { parseLensParam } from "@/components/board/board-filter-params"
import { BOARD_LENS_DEFS } from "@/lib/board/lens-defs"
import {
  THEME_OPTIONS,
  MESSAGE_DISPLAY_OPTIONS,
  UNREAD_OPEN_POSITION_OPTIONS,
  LABEL_REMOVE_ON_MOVE_OPTIONS,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MIN,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
  CODE_BLOCK_WRAP_OPTIONS,
  DEFAULT_CODE_BLOCK_WRAP,
  CODE_LANGUAGES,
  formatCodeLanguage,
  type CodeBlockWrap,
  MESSAGE_COLLAPSE_AT_HEIGHT_MIN,
  MESSAGE_COLLAPSE_AT_HEIGHT_MAX,
  DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT,
  MESSAGE_COLLAPSE_TO_HEIGHT_MIN,
  MESSAGE_COLLAPSE_TO_HEIGHT_MAX,
  DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT,
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN,
  BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX,
  DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN,
  BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX,
  DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT,
  BOARD_FULL_TAIL_COUNT_MIN,
  BOARD_FULL_TAIL_COUNT_MAX,
  DEFAULT_BOARD_FULL_TAIL_COUNT,
  BOARD_LEDGER_ROWS_MIN,
  BOARD_LEDGER_ROWS_MAX,
  DEFAULT_BOARD_LEDGER_ROWS,
  BOARD_LEAD_LINE_LENGTH_MIN,
  BOARD_LEAD_LINE_LENGTH_MAX,
  DEFAULT_BOARD_LEAD_LINE_LENGTH,
  BOARD_MASS_BADGE_MODES,
  normalizeBoardMassBadge,
  type BoardMassBadge,
  BOARD_LENSES,
  type Theme,
  type MessageDisplay,
  type UnreadOpenPosition,
  type LabelRemoveOnMove,
  type BoardLens,
} from "@threa/types"

const CODE_BLOCK_WRAP_LABELS: Record<CodeBlockWrap, string> = {
  scroll: "Scroll horizontally",
  wrap: "Wrap lines",
}

const CODE_LANGUAGE_OPTIONS = [...CODE_LANGUAGES].sort((a, b) => a.label.localeCompare(b.label))

const THEME_LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
}

const MESSAGE_DISPLAY_LABELS: Record<MessageDisplay, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
}

const MESSAGE_DISPLAY_DESCRIPTIONS: Record<MessageDisplay, string> = {
  compact: "More messages visible at once",
  comfortable: "More spacing between messages",
}

const UNREAD_OPEN_LABELS: Record<UnreadOpenPosition, string> = {
  latest: "At the latest message",
  marker: "At the first unread",
}

const UNREAD_OPEN_DESCRIPTIONS: Record<UnreadOpenPosition, string> = {
  latest: "Land at the bottom; a “N new messages” button jumps up to where you left off",
  marker: "Land where you left off; a “Jump to latest” button gets you back to the bottom",
}

const BOARD_MASS_BADGE_LABELS: Record<BoardMassBadge, string> = {
  count: "Unread message count",
  off: "No badge",
}

const BOARD_MASS_BADGE_DESCRIPTIONS: Record<BoardMassBadge, string> = {
  count: "How many messages you have not read yet",
  off: "Leave the head row bare",
}

const LABEL_REMOVE_LABELS: Record<LabelRemoveOnMove, string> = {
  ask: "Ask each time",
  always: "Remove the old label",
  never: "Keep the old label",
}

const LABEL_REMOVE_DESCRIPTIONS: Record<LabelRemoveOnMove, string> = {
  ask: "Prompt when you drag a labeled stream into a custom section or another label",
  always: "Drop the label it was sitting under whenever you move it elsewhere",
  never: "Leave labels alone — a moved stream keeps every label it had",
}

/**
 * Board home: the lens or saved view the bare `/board` lands on. Selecting a lens
 * clears any saved-view home (so the landing actually lands there); selecting a
 * view leaves the lens as the fallback for a stale/deleted view. Mirrors the pins
 * in the board's own lens menu.
 */
function BoardHomeSection({ workspaceId }: { workspaceId: string }) {
  const { preferences, updatePreferences } = usePreferences()
  const { data: views } = useBoardViews(workspaceId)
  const savedViews = views ?? []
  const boardDefaultLens = parseLensParam(preferences?.boardDefaultLens ?? null)
  // The resolved home view's id, or null when the home is a lens (or the stored id
  // no longer resolves) — land on the lens then.
  const activeViewId = useBoardHome(workspaceId).view?.id ?? null
  const value = activeViewId ? `view:${activeViewId}` : `lens:${boardDefaultLens}`

  const onChange = (next: string) => {
    if (next.startsWith("view:")) void updatePreferences({ boardDefaultViewId: next.slice("view:".length) })
    else void updatePreferences({ boardDefaultLens: next.slice("lens:".length) as BoardLens, boardDefaultViewId: null })
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Board home</h3>
        <p className="text-sm text-muted-foreground">
          The lens or saved view the board opens on. Every lens and view still has its own URL — this only picks where
          you land
        </p>
      </div>
      <RadioGroup value={value} onValueChange={onChange} className="space-y-3">
        {BOARD_LENSES.map((option) => (
          <div key={option} className="flex items-start space-x-3">
            <RadioGroupItem value={`lens:${option}`} id={`board-home-lens-${option}`} className="mt-1" />
            <div className="grid gap-1">
              <Label htmlFor={`board-home-lens-${option}`} className="cursor-pointer">
                {BOARD_LENS_DEFS[option].label}
              </Label>
              <p className="text-sm text-muted-foreground">{BOARD_LENS_DEFS[option].description}</p>
            </div>
          </div>
        ))}
        {savedViews.length > 0 && (
          <>
            <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Saved views</p>
            {savedViews.map((view) => (
              <div key={view.id} className="flex items-start space-x-3">
                <RadioGroupItem value={`view:${view.id}`} id={`board-home-view-${view.id}`} className="mt-1" />
                <div className="grid gap-1">
                  <Label htmlFor={`board-home-view-${view.id}`} className="cursor-pointer">
                    {view.name}
                  </Label>
                  <p className="text-sm text-muted-foreground">{summarizeBoardView(view)}</p>
                </div>
              </div>
            ))}
          </>
        )}
      </RadioGroup>
    </section>
  )
}

export function AppearanceSettings() {
  const { preferences, updatePreference } = usePreferences()
  const { workspaceId } = useParams<{ workspaceId: string }>()

  const theme = preferences?.theme ?? "system"
  const messageDisplay = preferences?.messageDisplay ?? "comfortable"
  const labelRemoveOnMove = preferences?.labelRemoveOnMove ?? "ask"
  const unreadOpenPosition = preferences?.unreadOpenPosition ?? "latest"
  const codeBlockThreshold = preferences?.codeBlockCollapseThreshold ?? DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD
  const blockquoteThreshold = preferences?.blockquoteCollapseThreshold ?? DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD
  const codeBlockWrap = preferences?.codeBlockWrap ?? DEFAULT_CODE_BLOCK_WRAP
  const codeBlockWrapOverrides = preferences?.codeBlockWrapOverrides ?? {}
  const codeBlockWrapOverrideRows = Object.entries(codeBlockWrapOverrides).sort(([leftId], [rightId]) =>
    formatCodeLanguage(leftId).localeCompare(formatCodeLanguage(rightId))
  )
  const codeBlockWrapUnusedLanguages = CODE_LANGUAGE_OPTIONS.filter(
    (language) => !(language.id in codeBlockWrapOverrides)
  )
  const messageCollapseEnabled = preferences?.messageCollapseEnabled ?? false
  const messageCollapseAtHeight = preferences?.messageCollapseAtHeight ?? DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT
  const messageCollapseToHeight = preferences?.messageCollapseToHeight ?? DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT
  const boardCardCollapseEnabled = preferences?.boardCardCollapseEnabled ?? false
  const boardCardCollapseAtHeight = preferences?.boardCardCollapseAtHeight ?? DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT
  const boardCardCollapseToHeight = preferences?.boardCardCollapseToHeight ?? DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT
  const boardFullTailCount = preferences?.boardFullTailCount ?? DEFAULT_BOARD_FULL_TAIL_COUNT
  const boardLedgerRows = preferences?.boardLedgerRows ?? DEFAULT_BOARD_LEDGER_ROWS
  const boardLeadLineLength = preferences?.boardLeadLineLength ?? DEFAULT_BOARD_LEAD_LINE_LENGTH
  const boardMassBadge = normalizeBoardMassBadge(preferences?.boardMassBadge)

  // Local input state so users can type freely without each keystroke
  // hitting the preferences mutation. We commit on blur / Enter only.
  const [codeThresholdDraft, setCodeThresholdDraft] = useState<string>(String(codeBlockThreshold))
  useEffect(() => {
    setCodeThresholdDraft(String(codeBlockThreshold))
  }, [codeBlockThreshold])

  const [blockquoteThresholdDraft, setBlockquoteThresholdDraft] = useState<string>(String(blockquoteThreshold))
  useEffect(() => {
    setBlockquoteThresholdDraft(String(blockquoteThreshold))
  }, [blockquoteThreshold])

  const [messageCollapseAtDraft, setMessageCollapseAtDraft] = useState<string>(String(messageCollapseAtHeight))
  useEffect(() => {
    setMessageCollapseAtDraft(String(messageCollapseAtHeight))
  }, [messageCollapseAtHeight])

  const [messageCollapseToDraft, setMessageCollapseToDraft] = useState<string>(String(messageCollapseToHeight))
  useEffect(() => {
    setMessageCollapseToDraft(String(messageCollapseToHeight))
  }, [messageCollapseToHeight])

  const [boardCardCollapseAtDraft, setBoardCardCollapseAtDraft] = useState<string>(String(boardCardCollapseAtHeight))
  useEffect(() => {
    setBoardCardCollapseAtDraft(String(boardCardCollapseAtHeight))
  }, [boardCardCollapseAtHeight])

  const [boardCardCollapseToDraft, setBoardCardCollapseToDraft] = useState<string>(String(boardCardCollapseToHeight))
  useEffect(() => {
    setBoardCardCollapseToDraft(String(boardCardCollapseToHeight))
  }, [boardCardCollapseToHeight])

  const [boardFullTailDraft, setBoardFullTailDraft] = useState<string>(String(boardFullTailCount))
  useEffect(() => {
    setBoardFullTailDraft(String(boardFullTailCount))
  }, [boardFullTailCount])

  const [boardLedgerRowsDraft, setBoardLedgerRowsDraft] = useState<string>(String(boardLedgerRows))
  useEffect(() => {
    setBoardLedgerRowsDraft(String(boardLedgerRows))
  }, [boardLedgerRows])

  const [boardLeadLineDraft, setBoardLeadLineDraft] = useState<string>(String(boardLeadLineLength))
  useEffect(() => {
    setBoardLeadLineDraft(String(boardLeadLineLength))
  }, [boardLeadLineLength])

  const commitBoardFullTailCount = () => {
    const parsed = Number.parseInt(boardFullTailDraft, 10)
    if (!Number.isFinite(parsed)) {
      setBoardFullTailDraft(String(boardFullTailCount))
      return
    }
    const clamped = Math.min(BOARD_FULL_TAIL_COUNT_MAX, Math.max(BOARD_FULL_TAIL_COUNT_MIN, parsed))
    setBoardFullTailDraft(String(clamped))
    if (clamped === boardFullTailCount) return
    void updatePreference("boardFullTailCount", clamped)
  }

  const commitBoardLedgerRows = () => {
    const parsed = Number.parseInt(boardLedgerRowsDraft, 10)
    if (!Number.isFinite(parsed)) {
      setBoardLedgerRowsDraft(String(boardLedgerRows))
      return
    }
    const clamped = Math.min(BOARD_LEDGER_ROWS_MAX, Math.max(BOARD_LEDGER_ROWS_MIN, parsed))
    setBoardLedgerRowsDraft(String(clamped))
    if (clamped === boardLedgerRows) return
    void updatePreference("boardLedgerRows", clamped)
  }

  const commitBoardLeadLineLength = () => {
    const parsed = Number.parseInt(boardLeadLineDraft, 10)
    if (!Number.isFinite(parsed)) {
      setBoardLeadLineDraft(String(boardLeadLineLength))
      return
    }
    const clamped = Math.min(BOARD_LEAD_LINE_LENGTH_MAX, Math.max(BOARD_LEAD_LINE_LENGTH_MIN, parsed))
    setBoardLeadLineDraft(String(clamped))
    if (clamped === boardLeadLineLength) return
    void updatePreference("boardLeadLineLength", clamped)
  }

  const commitCodeThreshold = () => {
    const parsed = Number.parseInt(codeThresholdDraft, 10)
    if (!Number.isFinite(parsed)) {
      setCodeThresholdDraft(String(codeBlockThreshold))
      return
    }
    const clamped = Math.min(CODE_BLOCK_COLLAPSE_THRESHOLD_MAX, Math.max(CODE_BLOCK_COLLAPSE_THRESHOLD_MIN, parsed))
    if (clamped === codeBlockThreshold) {
      setCodeThresholdDraft(String(clamped))
      return
    }
    void updatePreference("codeBlockCollapseThreshold", clamped)
  }

  const setCodeBlockWrapOverride = (languageId: string, mode: CodeBlockWrap | null) => {
    const next = { ...codeBlockWrapOverrides }
    if (mode === null) delete next[languageId]
    else next[languageId] = mode
    void updatePreference("codeBlockWrapOverrides", next)
  }

  const commitBlockquoteThreshold = () => {
    const parsed = Number.parseInt(blockquoteThresholdDraft, 10)
    if (!Number.isFinite(parsed)) {
      setBlockquoteThresholdDraft(String(blockquoteThreshold))
      return
    }
    const clamped = Math.min(BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX, Math.max(BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN, parsed))
    if (clamped === blockquoteThreshold) {
      setBlockquoteThresholdDraft(String(clamped))
      return
    }
    void updatePreference("blockquoteCollapseThreshold", clamped)
  }

  const commitMessageCollapseAtHeight = () => {
    const parsed = Number.parseInt(messageCollapseAtDraft, 10)
    if (!Number.isFinite(parsed)) {
      setMessageCollapseAtDraft(String(messageCollapseAtHeight))
      return
    }
    const clamped = Math.min(MESSAGE_COLLAPSE_AT_HEIGHT_MAX, Math.max(MESSAGE_COLLAPSE_AT_HEIGHT_MIN, parsed))
    const nextCollapseToHeight = Math.min(messageCollapseToHeight, clamped)
    if (clamped === messageCollapseAtHeight && nextCollapseToHeight === messageCollapseToHeight) {
      setMessageCollapseAtDraft(String(clamped))
      return
    }
    void updatePreference("messageCollapseAtHeight", clamped)
    if (nextCollapseToHeight !== messageCollapseToHeight) {
      setMessageCollapseToDraft(String(nextCollapseToHeight))
      void updatePreference("messageCollapseToHeight", nextCollapseToHeight)
    }
  }

  const commitMessageCollapseToHeight = () => {
    const parsed = Number.parseInt(messageCollapseToDraft, 10)
    if (!Number.isFinite(parsed)) {
      setMessageCollapseToDraft(String(messageCollapseToHeight))
      return
    }
    const bounded = Math.min(MESSAGE_COLLAPSE_TO_HEIGHT_MAX, Math.max(MESSAGE_COLLAPSE_TO_HEIGHT_MIN, parsed))
    const clamped = Math.min(bounded, messageCollapseAtHeight)
    if (clamped === messageCollapseToHeight) {
      setMessageCollapseToDraft(String(clamped))
      return
    }
    setMessageCollapseToDraft(String(clamped))
    void updatePreference("messageCollapseToHeight", clamped)
  }

  const commitBoardCardCollapseAtHeight = () => {
    const parsed = Number.parseInt(boardCardCollapseAtDraft, 10)
    if (!Number.isFinite(parsed)) {
      setBoardCardCollapseAtDraft(String(boardCardCollapseAtHeight))
      return
    }
    const clamped = Math.min(BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX, Math.max(BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN, parsed))
    const nextCollapseToHeight = Math.min(boardCardCollapseToHeight, clamped)
    if (clamped === boardCardCollapseAtHeight && nextCollapseToHeight === boardCardCollapseToHeight) {
      setBoardCardCollapseAtDraft(String(clamped))
      return
    }
    void updatePreference("boardCardCollapseAtHeight", clamped)
    if (nextCollapseToHeight !== boardCardCollapseToHeight) {
      setBoardCardCollapseToDraft(String(nextCollapseToHeight))
      void updatePreference("boardCardCollapseToHeight", nextCollapseToHeight)
    }
  }

  const commitBoardCardCollapseToHeight = () => {
    const parsed = Number.parseInt(boardCardCollapseToDraft, 10)
    if (!Number.isFinite(parsed)) {
      setBoardCardCollapseToDraft(String(boardCardCollapseToHeight))
      return
    }
    const bounded = Math.min(BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX, Math.max(BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN, parsed))
    const clamped = Math.min(bounded, boardCardCollapseAtHeight)
    if (clamped === boardCardCollapseToHeight) {
      setBoardCardCollapseToDraft(String(clamped))
      return
    }
    setBoardCardCollapseToDraft(String(clamped))
    void updatePreference("boardCardCollapseToHeight", clamped)
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Theme</h3>
          <p className="text-sm text-muted-foreground">Choose how Threa looks to you</p>
        </div>
        <RadioGroup
          value={theme}
          onValueChange={(value) => updatePreference("theme", value as Theme)}
          className="grid grid-cols-3 gap-4"
        >
          {THEME_OPTIONS.map((option) => (
            <div key={option}>
              <RadioGroupItem value={option} id={`theme-${option}`} className="peer sr-only" />
              <Label
                htmlFor={`theme-${option}`}
                className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
              >
                {THEME_LABELS[option]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Message Display</h3>
          <p className="text-sm text-muted-foreground">Choose how messages are displayed</p>
        </div>
        <RadioGroup
          value={messageDisplay}
          onValueChange={(value) => updatePreference("messageDisplay", value as MessageDisplay)}
          className="space-y-3"
        >
          {MESSAGE_DISPLAY_OPTIONS.map((option) => (
            <div key={option} className="flex items-start space-x-3">
              <RadioGroupItem value={option} id={`display-${option}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`display-${option}`} className="cursor-pointer">
                  {MESSAGE_DISPLAY_LABELS[option]}
                </Label>
                <p className="text-sm text-muted-foreground">{MESSAGE_DISPLAY_DESCRIPTIONS[option]}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Opening unread streams</h3>
          <p className="text-sm text-muted-foreground">Where a stream opens when it has unread messages</p>
        </div>
        <RadioGroup
          value={unreadOpenPosition}
          onValueChange={(value) => updatePreference("unreadOpenPosition", value as UnreadOpenPosition)}
          className="space-y-3"
        >
          {UNREAD_OPEN_POSITION_OPTIONS.map((option) => (
            <div key={option} className="flex items-start space-x-3">
              <RadioGroupItem value={option} id={`unread-open-${option}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`unread-open-${option}`} className="cursor-pointer">
                  {UNREAD_OPEN_LABELS[option]}
                </Label>
                <p className="text-sm text-muted-foreground">{UNREAD_OPEN_DESCRIPTIONS[option]}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Code Blocks</h3>
          <p className="text-sm text-muted-foreground">Collapsing and line wrapping</p>
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="code-block-collapse-threshold" className="cursor-pointer">
              Collapse threshold
            </Label>
            <p className="text-sm text-muted-foreground">
              Code blocks with more than this many lines start collapsed. You can always click to expand or collapse
              individual blocks.
            </p>
          </div>
          <Input
            id="code-block-collapse-threshold"
            type="number"
            inputMode="numeric"
            min={CODE_BLOCK_COLLAPSE_THRESHOLD_MIN}
            max={CODE_BLOCK_COLLAPSE_THRESHOLD_MAX}
            value={codeThresholdDraft}
            onChange={(event) => setCodeThresholdDraft(event.target.value)}
            onBlur={commitCodeThreshold}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitCodeThreshold()
              }
            }}
            className="w-24"
          />
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label id="code-block-wrap-label">Long lines</Label>
            <p className="text-sm text-muted-foreground">How lines wider than the message are shown</p>
          </div>
          <RadioGroup
            aria-labelledby="code-block-wrap-label"
            value={codeBlockWrap}
            onValueChange={(value) => updatePreference("codeBlockWrap", value as CodeBlockWrap)}
            className="space-y-2"
          >
            {CODE_BLOCK_WRAP_OPTIONS.map((option) => (
              <div key={option} className="flex items-center gap-2">
                <RadioGroupItem value={option} id={`code-block-wrap-${option}`} />
                <Label htmlFor={`code-block-wrap-${option}`} className="cursor-pointer font-normal">
                  {CODE_BLOCK_WRAP_LABELS[option]}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>
        <div className="grid gap-2">
          <Label id="code-block-wrap-overrides-label">Per language</Label>
          {codeBlockWrapOverrideRows.map(([languageId, mode]) => (
            <div key={languageId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{formatCodeLanguage(languageId)}</span>
              <Select
                value={mode}
                onValueChange={(value) => setCodeBlockWrapOverride(languageId, value as CodeBlockWrap)}
              >
                <SelectTrigger className="w-40 shrink-0" aria-label={`Long lines in ${formatCodeLanguage(languageId)}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CODE_BLOCK_WRAP_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {CODE_BLOCK_WRAP_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setCodeBlockWrapOverride(languageId, null)}
                aria-label={`Remove ${formatCodeLanguage(languageId)} override`}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Select
            value=""
            onValueChange={(languageId) =>
              setCodeBlockWrapOverride(languageId, codeBlockWrap === "wrap" ? "scroll" : "wrap")
            }
          >
            <SelectTrigger className="w-40" aria-labelledby="code-block-wrap-overrides-label">
              <SelectValue placeholder="Add language" />
            </SelectTrigger>
            <SelectContent>
              {codeBlockWrapUnusedLanguages.map((language) => (
                <SelectItem key={language.id} value={language.id}>
                  {language.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Block Quotes</h3>
          <p className="text-sm text-muted-foreground">
            Collapse long quotes and quote replies by default to keep messages scannable
          </p>
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="blockquote-collapse-threshold" className="cursor-pointer">
              Collapse threshold
            </Label>
            <p className="text-sm text-muted-foreground">
              Block quotes and quote replies with more than this many lines start collapsed. You can always click to
              expand or collapse individual quotes.
            </p>
          </div>
          <Input
            id="blockquote-collapse-threshold"
            type="number"
            inputMode="numeric"
            min={BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN}
            max={BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX}
            value={blockquoteThresholdDraft}
            onChange={(event) => setBlockquoteThresholdDraft(event.target.value)}
            onBlur={commitBlockquoteThreshold}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitBlockquoteThreshold()
              }
            }}
            className="w-24"
          />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Long Messages</h3>
          <p className="text-sm text-muted-foreground">
            Message bodies stay open by default unless you turn on automatic collapsing. Manual Show more/less choices
            are remembered per message.
          </p>
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="message-collapse-enabled" className="cursor-pointer">
              Collapse long messages automatically
            </Label>
            <p className="text-sm text-muted-foreground">
              When off, long messages stay open but can still be collapsed manually.
            </p>
          </div>
          <Switch
            id="message-collapse-enabled"
            checked={messageCollapseEnabled}
            onCheckedChange={(checked) => updatePreference("messageCollapseEnabled", checked)}
          />
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="message-collapse-at-height" className="cursor-pointer">
              Collapse at height (px)
            </Label>
            <p className="text-sm text-muted-foreground">
              Messages taller than this show the Show more/less control. This also decides when automatic collapsing
              applies.
            </p>
          </div>
          <Input
            id="message-collapse-at-height"
            type="number"
            inputMode="numeric"
            min={MESSAGE_COLLAPSE_AT_HEIGHT_MIN}
            max={MESSAGE_COLLAPSE_AT_HEIGHT_MAX}
            value={messageCollapseAtDraft}
            onChange={(event) => setMessageCollapseAtDraft(event.target.value)}
            onBlur={commitMessageCollapseAtHeight}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitMessageCollapseAtHeight()
              }
            }}
            className="w-24"
          />
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="message-collapse-to-height" className="cursor-pointer">
              Collapse to height (px)
            </Label>
            <p className="text-sm text-muted-foreground">
              Collapsed messages keep this much visible instead of disappearing to a single line.
            </p>
          </div>
          <Input
            id="message-collapse-to-height"
            type="number"
            inputMode="numeric"
            min={MESSAGE_COLLAPSE_TO_HEIGHT_MIN}
            max={MESSAGE_COLLAPSE_TO_HEIGHT_MAX}
            value={messageCollapseToDraft}
            onChange={(event) => setMessageCollapseToDraft(event.target.value)}
            onBlur={commitMessageCollapseToHeight}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitMessageCollapseToHeight()
              }
            }}
            className="w-24"
          />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Board Cards</h3>
          <p className="text-sm text-muted-foreground">
            Board cards stay open by default unless you turn on automatic collapsing. Manual card expand/collapse
            choices are remembered per conversation.
          </p>
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="board-card-collapse-enabled" className="cursor-pointer">
              Collapse tall board cards automatically
            </Label>
            <p className="text-sm text-muted-foreground">
              When off, board cards stay open but can still be collapsed manually.
            </p>
          </div>
          <Switch
            id="board-card-collapse-enabled"
            checked={boardCardCollapseEnabled}
            onCheckedChange={(checked) => updatePreference("boardCardCollapseEnabled", checked)}
          />
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="board-card-collapse-at-height" className="cursor-pointer">
              Collapse at height (px)
            </Label>
            <p className="text-sm text-muted-foreground">
              Board cards taller than this start collapsed when automatic collapsing is on. The header chevron still
              lets you collapse or expand any card manually.
            </p>
          </div>
          <Input
            id="board-card-collapse-at-height"
            type="number"
            inputMode="numeric"
            min={BOARD_CARD_COLLAPSE_AT_HEIGHT_MIN}
            max={BOARD_CARD_COLLAPSE_AT_HEIGHT_MAX}
            value={boardCardCollapseAtDraft}
            onChange={(event) => setBoardCardCollapseAtDraft(event.target.value)}
            onBlur={commitBoardCardCollapseAtHeight}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitBoardCardCollapseAtHeight()
              }
            }}
            className="w-24"
          />
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="board-card-collapse-to-height" className="cursor-pointer">
              Collapse to height (px)
            </Label>
            <p className="text-sm text-muted-foreground">
              Collapsed board cards keep this much conversation body visible.
            </p>
          </div>
          <Input
            id="board-card-collapse-to-height"
            type="number"
            inputMode="numeric"
            min={BOARD_CARD_COLLAPSE_TO_HEIGHT_MIN}
            max={BOARD_CARD_COLLAPSE_TO_HEIGHT_MAX}
            value={boardCardCollapseToDraft}
            onChange={(event) => setBoardCardCollapseToDraft(event.target.value)}
            onBlur={commitBoardCardCollapseToHeight}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitBoardCardCollapseToHeight()
              }
            }}
            className="w-24"
          />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Board Ledger</h3>
          <p className="text-sm text-muted-foreground">
            How a board card splits between the newest messages, rendered in full, and the compact ledger rows above
            them
          </p>
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="board-full-tail-count" className="cursor-pointer">
              Messages shown in full
            </Label>
            <p className="text-sm text-muted-foreground">
              The newest messages on a card render as full message bodies. Everything older becomes a ledger row.
            </p>
          </div>
          <Input
            id="board-full-tail-count"
            type="number"
            inputMode="numeric"
            min={BOARD_FULL_TAIL_COUNT_MIN}
            max={BOARD_FULL_TAIL_COUNT_MAX}
            value={boardFullTailDraft}
            onChange={(event) => setBoardFullTailDraft(event.target.value)}
            onBlur={commitBoardFullTailCount}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitBoardFullTailCount()
              }
            }}
            className="w-24"
          />
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="board-ledger-rows" className="cursor-pointer">
              Ledger rows
            </Label>
            <p className="text-sm text-muted-foreground">
              How many ledger rows a card keeps before the rest fold into a single head row.
            </p>
          </div>
          <Input
            id="board-ledger-rows"
            type="number"
            inputMode="numeric"
            min={BOARD_LEDGER_ROWS_MIN}
            max={BOARD_LEDGER_ROWS_MAX}
            value={boardLedgerRowsDraft}
            onChange={(event) => setBoardLedgerRowsDraft(event.target.value)}
            onBlur={commitBoardLedgerRows}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitBoardLedgerRows()
              }
            }}
            className="w-24"
          />
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="board-lead-line-length" className="cursor-pointer">
              Lead line length
            </Label>
            <p className="text-sm text-muted-foreground">
              Characters of a message kept on its ledger row before it is cut short.
            </p>
          </div>
          <Input
            id="board-lead-line-length"
            type="number"
            inputMode="numeric"
            min={BOARD_LEAD_LINE_LENGTH_MIN}
            max={BOARD_LEAD_LINE_LENGTH_MAX}
            value={boardLeadLineDraft}
            onChange={(event) => setBoardLeadLineDraft(event.target.value)}
            onBlur={commitBoardLeadLineLength}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitBoardLeadLineLength()
              }
            }}
            className="w-24"
          />
        </div>
        <div className="grid gap-1">
          <Label className="cursor-default">Head row badge</Label>
          <p className="text-sm text-muted-foreground">What the folded head row reports about the messages it hides</p>
        </div>
        <RadioGroup
          value={boardMassBadge}
          onValueChange={(value) => updatePreference("boardMassBadge", value as BoardMassBadge)}
          className="space-y-3"
        >
          {BOARD_MASS_BADGE_MODES.map((option) => (
            <div key={option} className="flex items-start space-x-3">
              <RadioGroupItem value={option} id={`board-mass-badge-${option}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`board-mass-badge-${option}`} className="cursor-pointer">
                  {BOARD_MASS_BADGE_LABELS[option]}
                </Label>
                <p className="text-sm text-muted-foreground">{BOARD_MASS_BADGE_DESCRIPTIONS[option]}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      {workspaceId && <BoardHomeSection workspaceId={workspaceId} />}

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Moving labeled streams</h3>
          <p className="text-sm text-muted-foreground">
            When you drag a labeled stream into a custom section or a different label, decide what happens to the label
            it was under
          </p>
        </div>
        <RadioGroup
          value={labelRemoveOnMove}
          onValueChange={(value) => updatePreference("labelRemoveOnMove", value as LabelRemoveOnMove)}
          className="space-y-3"
        >
          {LABEL_REMOVE_ON_MOVE_OPTIONS.map((option) => (
            <div key={option} className="flex items-start space-x-3">
              <RadioGroupItem value={option} id={`label-remove-${option}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`label-remove-${option}`} className="cursor-pointer">
                  {LABEL_REMOVE_LABELS[option]}
                </Label>
                <p className="text-sm text-muted-foreground">{LABEL_REMOVE_DESCRIPTIONS[option]}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>
    </div>
  )
}
