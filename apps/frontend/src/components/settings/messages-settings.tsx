import { useEffect, useState } from "react"
import { usePreferences } from "@/contexts"
import {
  BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX,
  CODE_BLOCK_COLLAPSE_THRESHOLD_MAX,
  CODE_BLOCK_WRAP_OPTIONS,
  CODE_LANGUAGES_BY_LABEL,
  DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
  DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD,
  DEFAULT_CODE_BLOCK_WRAP,
  DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT,
  DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT,
  MESSAGE_COLLAPSE_AT_HEIGHT_MAX,
  MESSAGE_COLLAPSE_AT_HEIGHT_MIN,
  MESSAGE_COLLAPSE_TO_HEIGHT_MAX,
  MESSAGE_COLLAPSE_TO_HEIGHT_MIN,
  formatCodeLanguage,
  type CodeBlockWrap,
} from "@threahq/types"
import { FoldPreview } from "./fold-preview"
import { SettingOverrideList } from "./setting-lists"
import { LinkPreviewSettings } from "./link-preview-settings"
import {
  ChoiceSetting,
  FOLD_AT_HEIGHT,
  FoldSetting,
  type FoldChoice,
  NumberSetting,
  SettingDependents,
  SettingsDisclosure,
  SettingsSection,
  settingIds,
} from "./setting-primitives"

const CODE_BLOCK_WRAP_LABELS: Record<CodeBlockWrap, string> = { scroll: "Scroll", wrap: "Wrap" }

export const CODE_BLOCK_WRAP_DESCRIPTIONS: Record<CodeBlockWrap, string> = {
  scroll: "Lines wider than the message scroll sideways.",
  wrap: "Lines wider than the message wrap onto the next line.",
}

type LineFold = { enabled: boolean; threshold: number }

/**
 * A line-count collapse: "Never", "Always" (stored as threshold 0), or "Taller
 * than" N lines. The last height is kept while another choice is picked, so
 * picking "Taller than" again restores it.
 */
function LineFoldSetting({
  setting,
  atSetting,
  fold,
  defaultThreshold,
  max,
  noun,
  onCommit,
}: {
  setting: "code-collapse" | "quote-collapse"
  atSetting: "code-collapse-at" | "quote-collapse-at"
  fold: LineFold
  defaultThreshold: number
  max: number
  noun: { one: string; many: string }
  onCommit: (fold: LineFold) => void
}) {
  const { enabled, threshold } = fold
  const [lastHeight, setLastHeight] = useState(threshold > 0 ? threshold : defaultThreshold)
  useEffect(() => {
    if (threshold > 0) setLastHeight(threshold)
  }, [threshold])
  let choice: FoldChoice = FOLD_AT_HEIGHT
  if (!enabled) choice = "never"
  else if (threshold === 0) choice = "always"
  return (
    <FoldSetting
      setting={setting}
      atSetting={atSetting}
      noun={noun}
      always
      choice={choice}
      onChoiceChange={(next) => {
        if (next === "never") onCommit({ enabled: false, threshold })
        else onCommit({ enabled: true, threshold: next === "always" ? 0 : lastHeight })
      }}
      value={threshold > 0 ? threshold : lastHeight}
      min={1}
      max={max}
      unit="lines"
      onCommit={(height) => onCommit({ enabled: true, threshold: height })}
    />
  )
}

export function MessagesSettings() {
  const { preferences, updatePreference, updatePreferences } = usePreferences()

  const codeFold = {
    enabled: preferences?.codeBlockCollapseEnabled ?? true,
    threshold: preferences?.codeBlockCollapseThreshold ?? DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD,
  }
  const quoteFold = {
    enabled: preferences?.blockquoteCollapseEnabled ?? true,
    threshold: preferences?.blockquoteCollapseThreshold ?? DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
  }
  const codeBlockWrap = preferences?.codeBlockWrap ?? DEFAULT_CODE_BLOCK_WRAP
  const codeBlockWrapOverrides = preferences?.codeBlockWrapOverrides ?? {}
  const overrideRows = Object.entries(codeBlockWrapOverrides).sort(([left], [right]) =>
    formatCodeLanguage(left).localeCompare(formatCodeLanguage(right))
  )
  const unusedLanguages = CODE_LANGUAGES_BY_LABEL.filter((language) => !(language.id in codeBlockWrapOverrides))
  const messageCollapseEnabled = preferences?.messageCollapseEnabled ?? false
  const messageCollapseAtHeight = preferences?.messageCollapseAtHeight ?? DEFAULT_MESSAGE_COLLAPSE_AT_HEIGHT
  const messageCollapseToHeight = preferences?.messageCollapseToHeight ?? DEFAULT_MESSAGE_COLLAPSE_TO_HEIGHT
  const [draftTo, setDraftTo] = useState<number | null>(null)

  const setCodeBlockWrapOverride = (languageId: string, mode: CodeBlockWrap | null) => {
    const next = { ...codeBlockWrapOverrides }
    if (mode === null) delete next[languageId]
    else next[languageId] = mode
    void updatePreference("codeBlockWrapOverrides", next)
  }

  return (
    <div className="space-y-8">
      <LinkPreviewSettings />

      <SettingsSection section="long-messages">
        <FoldSetting
          setting="message-collapse"
          atSetting="message-collapse-at"
          noun={{ one: "message", many: "messages" }}
          choice={messageCollapseEnabled ? FOLD_AT_HEIGHT : "never"}
          onChoiceChange={(choice) => void updatePreference("messageCollapseEnabled", choice === FOLD_AT_HEIGHT)}
          value={messageCollapseAtHeight}
          min={MESSAGE_COLLAPSE_AT_HEIGHT_MIN}
          max={MESSAGE_COLLAPSE_AT_HEIGHT_MAX}
          unit="px"
          // A collapsed message can't be taller than the height that collapses it.
          onCommit={(atHeight) =>
            void updatePreferences({
              messageCollapseEnabled: true,
              messageCollapseAtHeight: atHeight,
              messageCollapseToHeight: Math.min(messageCollapseToHeight, atHeight),
            })
          }
        >
          <NumberSetting
            setting="message-collapse-to"
            value={messageCollapseToHeight}
            min={MESSAGE_COLLAPSE_TO_HEIGHT_MIN}
            max={Math.min(MESSAGE_COLLAPSE_TO_HEIGHT_MAX, messageCollapseAtHeight)}
            unit="px"
            onDraftChange={setDraftTo}
            onCommit={(toHeight) => void updatePreference("messageCollapseToHeight", toHeight)}
          >
            {messageCollapseEnabled && <FoldPreview foldTo={draftTo ?? messageCollapseToHeight} />}
          </NumberSetting>
        </FoldSetting>
      </SettingsSection>

      <SettingsSection section="code-blocks">
        <LineFoldSetting
          setting="code-collapse"
          atSetting="code-collapse-at"
          fold={codeFold}
          defaultThreshold={DEFAULT_CODE_BLOCK_COLLAPSE_THRESHOLD}
          max={CODE_BLOCK_COLLAPSE_THRESHOLD_MAX}
          noun={{ one: "code block", many: "code blocks" }}
          onCommit={({ enabled, threshold }) =>
            void updatePreferences({ codeBlockCollapseEnabled: enabled, codeBlockCollapseThreshold: threshold })
          }
        />
        <ChoiceSetting
          setting="code-wrap"
          value={codeBlockWrap}
          options={CODE_BLOCK_WRAP_OPTIONS.map((value) => ({
            value,
            label: CODE_BLOCK_WRAP_LABELS[value],
            description: CODE_BLOCK_WRAP_DESCRIPTIONS[value],
          }))}
          variant="segmented"
          onValueChange={(value) => updatePreference("codeBlockWrap", value)}
        />
        <SettingDependents parent="code-wrap">
          <SettingsDisclosure
            setting="code-wrap-languages"
            summary={
              overrideRows.length === 0
                ? "Every language follows the default"
                : `Own setting for ${overrideRows.map(([languageId]) => formatCodeLanguage(languageId)).join(", ")}`
            }
          >
            <SettingOverrideList<CodeBlockWrap>
              aria-labelledby={settingIds("code-wrap-languages").label}
              options={CODE_BLOCK_WRAP_OPTIONS.map((option) => ({
                value: option,
                label: CODE_BLOCK_WRAP_LABELS[option],
              }))}
              selectLabel={(label) => `Long lines in ${label}`}
              removeLabel={(label) => `Remove ${label} override`}
              items={overrideRows.map(([languageId, mode]) => ({
                key: languageId,
                label: formatCodeLanguage(languageId),
                value: mode,
                onValueChange: (value) => setCodeBlockWrapOverride(languageId, value),
                onRemove: () => setCodeBlockWrapOverride(languageId, null),
              }))}
              add={{
                label: "Add a language",
                options: unusedLanguages.map((language) => ({ value: language.id, label: language.label })),
                onAdd: (languageId) =>
                  setCodeBlockWrapOverride(languageId, codeBlockWrap === "wrap" ? "scroll" : "wrap"),
              }}
            />
          </SettingsDisclosure>
        </SettingDependents>
      </SettingsSection>

      <SettingsSection section="block-quotes">
        <LineFoldSetting
          setting="quote-collapse"
          atSetting="quote-collapse-at"
          fold={quoteFold}
          defaultThreshold={DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD}
          max={BLOCKQUOTE_COLLAPSE_THRESHOLD_MAX}
          noun={{ one: "quote", many: "quotes" }}
          onCommit={({ enabled, threshold }) =>
            void updatePreferences({ blockquoteCollapseEnabled: enabled, blockquoteCollapseThreshold: threshold })
          }
        />
      </SettingsSection>
    </div>
  )
}
