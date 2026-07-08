import { useEffect, useState } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { usePreferences } from "@/contexts"
import { BOARD_LENS_DEFS } from "@/lib/board/lens-defs"
import {
  THEME_OPTIONS,
  MESSAGE_DISPLAY_OPTIONS,
  LABEL_REMOVE_ON_MOVE_OPTIONS,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MIN,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MIN,
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
  MESSAGE_COLLAPSE_AT_HEIGHT_MIN,
  MESSAGE_COLLAPSE_AT_HEIGHT_MAX,
  DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT,
  MESSAGE_COLLAPSE_TO_HEIGHT_MIN,
  MESSAGE_COLLAPSE_TO_HEIGHT_MAX,
  DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT,
  BOARD_CARD_COLLAPSE_THRESHOLD_MIN,
  BOARD_CARD_COLLAPSE_THRESHOLD_MAX,
  DEFAULT_BOARD_CARD_COLLAPSE_THRESHOLD,
  BOARD_LENSES,
  DEFAULT_BOARD_LENS,
  type Theme,
  type MessageDisplay,
  type LabelRemoveOnMove,
  type BoardLens,
} from "@threa/types"

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

export function AppearanceSettings() {
  const { preferences, updatePreference } = usePreferences()

  const theme = preferences?.theme ?? "system"
  const messageDisplay = preferences?.messageDisplay ?? "comfortable"
  const labelRemoveOnMove = preferences?.labelRemoveOnMove ?? "ask"
  const codeBlockThreshold = preferences?.codeBlockCollapseThreshold ?? DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD
  const blockquoteThreshold = preferences?.blockquoteCollapseThreshold ?? DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD
  const messageCollapseEnabled = preferences?.messageCollapseEnabled ?? false
  const messageCollapseAtHeight = preferences?.messageCollapseAtHeight ?? DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT
  const messageCollapseToHeight = preferences?.messageCollapseToHeight ?? DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT
  const boardCardThreshold = preferences?.boardCardCollapseThreshold ?? DEFAULT_BOARD_CARD_COLLAPSE_THRESHOLD
  const boardDefaultLens = preferences?.boardDefaultLens ?? DEFAULT_BOARD_LENS

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

  const [boardCardThresholdDraft, setBoardCardThresholdDraft] = useState<string>(String(boardCardThreshold))
  useEffect(() => {
    setBoardCardThresholdDraft(String(boardCardThreshold))
  }, [boardCardThreshold])

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
    if (clamped === messageCollapseAtHeight) {
      setMessageCollapseAtDraft(String(clamped))
      return
    }
    void updatePreference("messageCollapseAtHeight", clamped)
  }

  const commitMessageCollapseToHeight = () => {
    const parsed = Number.parseInt(messageCollapseToDraft, 10)
    if (!Number.isFinite(parsed)) {
      setMessageCollapseToDraft(String(messageCollapseToHeight))
      return
    }
    const clamped = Math.min(MESSAGE_COLLAPSE_TO_HEIGHT_MAX, Math.max(MESSAGE_COLLAPSE_TO_HEIGHT_MIN, parsed))
    if (clamped === messageCollapseToHeight) {
      setMessageCollapseToDraft(String(clamped))
      return
    }
    void updatePreference("messageCollapseToHeight", clamped)
  }

  const commitBoardCardThreshold = () => {
    const parsed = Number.parseInt(boardCardThresholdDraft, 10)
    if (!Number.isFinite(parsed)) {
      setBoardCardThresholdDraft(String(boardCardThreshold))
      return
    }
    const clamped = Math.min(BOARD_CARD_COLLAPSE_THRESHOLD_MAX, Math.max(BOARD_CARD_COLLAPSE_THRESHOLD_MIN, parsed))
    if (clamped === boardCardThreshold) {
      setBoardCardThresholdDraft(String(clamped))
      return
    }
    void updatePreference("boardCardCollapseThreshold", clamped)
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
          <h3 className="text-sm font-medium">Code Blocks</h3>
          <p className="text-sm text-muted-foreground">
            Collapse long code blocks by default to keep messages scannable
          </p>
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
            Collapse tall conversations to their header on the board so compact ones stay open
          </p>
        </div>
        <div className="flex items-start gap-4">
          <div className="grid gap-1 flex-1">
            <Label htmlFor="board-card-collapse-threshold" className="cursor-pointer">
              Collapse height (px)
            </Label>
            <p className="text-sm text-muted-foreground">
              Conversations taller than this many pixels start collapsed on the board — a long message folds as readily
              as a long back-and-forth. You can always expand or collapse an individual card. Set to 0 to collapse every
              card by default.
            </p>
          </div>
          <Input
            id="board-card-collapse-threshold"
            type="number"
            inputMode="numeric"
            min={BOARD_CARD_COLLAPSE_THRESHOLD_MIN}
            max={BOARD_CARD_COLLAPSE_THRESHOLD_MAX}
            value={boardCardThresholdDraft}
            onChange={(event) => setBoardCardThresholdDraft(event.target.value)}
            onBlur={commitBoardCardThreshold}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitBoardCardThreshold()
              }
            }}
            className="w-24"
          />
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Board home</h3>
          <p className="text-sm text-muted-foreground">
            The lens the board opens on. Every lens still has its own view — this only picks where you land
          </p>
        </div>
        <RadioGroup
          value={boardDefaultLens}
          onValueChange={(value) => updatePreference("boardDefaultLens", value as BoardLens)}
          className="space-y-3"
        >
          {BOARD_LENSES.map((option) => (
            <div key={option} className="flex items-start space-x-3">
              <RadioGroupItem value={option} id={`board-lens-${option}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`board-lens-${option}`} className="cursor-pointer">
                  {BOARD_LENS_DEFS[option].label}
                </Label>
                <p className="text-sm text-muted-foreground">{BOARD_LENS_DEFS[option].description}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>

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
