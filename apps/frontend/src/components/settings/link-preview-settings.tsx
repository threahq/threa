import {
  LINK_PREVIEW_CATEGORIES,
  DEFAULT_LINK_PREVIEW_OPEN_COUNT,
  type LinkPreviewCategory,
  type LinkPreviewLimit,
} from "@threahq/types"
import { usePreferences } from "@/contexts"
import { useCommittedInteger } from "./committed-field"
import {
  ChoiceSetting,
  NumberFieldError,
  NumberInput,
  SettingsDisclosure,
  SettingsSection,
  settingIds,
} from "./setting-primitives"
import { SettingOverrideList } from "./setting-lists"
import { settingDef } from "./settings-registry"

const CATEGORY_LABELS: Record<LinkPreviewCategory, string> = {
  image: "Images",
  video: "Videos",
  github: "GitHub",
  linear: "Linear",
  website: "Websites",
  pdf: "PDFs",
}

function overridesSummary(overrides: Partial<Record<LinkPreviewCategory, LinkPreviewLimit>>): string {
  const own = LINK_PREVIEW_CATEGORIES.filter((category) => overrides[category] !== undefined)
  if (own.length === 0) return "All types follow the default"
  return `Own count for ${own.map((category) => CATEGORY_LABELS[category]).join(", ")}`
}

type LimitMode = "default" | "none" | "count" | "all"

function modeOf(value: LinkPreviewLimit | undefined): LimitMode {
  if (value === undefined) return "default"
  if (value === "all") return "all"
  return value === 0 ? "none" : "count"
}

const MODE_LABELS: Record<LimitMode, string> = { default: "Default", none: "None", count: "First", all: "All" }

const MODE_DESCRIPTIONS: Record<Exclude<LimitMode, "default">, string> = {
  none: "Previews start collapsed. Select one to open it.",
  count: "Later links in the message start collapsed.",
  all: "Every link in a message shows its preview.",
}

const TYPE_MODE_OPTIONS = (["default", "none", "count", "all"] as const).map((value) => ({
  value,
  label: MODE_LABELS[value],
}))

/**
 * One limit: none, the first [N], or all (plus the default, for a link type).
 * The count saves like any typed number (`useCommittedInteger`); choosing
 * "First" again restores the count left in the field.
 */
function useLimit(value: LinkPreviewLimit | undefined, onSave: (value: LinkPreviewLimit | undefined) => void) {
  const count = useCommittedInteger({
    saved: typeof value === "number" && value > 0 ? value : null,
    initial: DEFAULT_LINK_PREVIEW_OPEN_COUNT,
    min: 1,
    onCommit: onSave,
  })

  function choose(next: string) {
    const typed = count.settle()
    if (next === "default") onSave(undefined)
    else if (next === "all") onSave("all")
    else if (next === "none") onSave(0)
    else onSave(typed ?? DEFAULT_LINK_PREVIEW_OPEN_COUNT)
  }

  return { mode: modeOf(value), choose, ...count }
}

function PreviewCountSetting({
  value,
  disabled,
  onSave,
}: {
  value: LinkPreviewLimit
  disabled: boolean
  onSave: (value: LinkPreviewLimit) => void
}) {
  const limit = useLimit(value, (next) => next !== undefined && onSave(next))
  const countId = `${settingIds("link-preview-count").control}-count`
  return (
    <ChoiceSetting
      setting="link-preview-count"
      variant="list"
      value={limit.mode}
      disabled={disabled}
      onValueChange={limit.choose}
      options={(["none", "count", "all"] as const).map((mode) => ({
        value: mode,
        label: MODE_LABELS[mode],
        description: MODE_DESCRIPTIONS[mode],
        trailing:
          mode === "count" ? (
            <div className="grid gap-1">
              <NumberInput
                id={countId}
                field={limit}
                min={1}
                unit="previews"
                compact
                aria-label={`${settingDef("link-preview-count").label}, how many`}
                disabled={disabled}
              />
              {limit.invalid && <NumberFieldError id={countId} min={1} />}
            </div>
          ) : undefined,
      }))}
    />
  )
}

function TypeOverrides({
  overrides,
  disabled,
  onSave,
}: {
  overrides: Partial<Record<LinkPreviewCategory, LinkPreviewLimit>>
  disabled: boolean
  onSave: (category: LinkPreviewCategory, value: LinkPreviewLimit | undefined) => void
}) {
  const limits = {
    image: useLimit(overrides.image, (value) => onSave("image", value)),
    video: useLimit(overrides.video, (value) => onSave("video", value)),
    github: useLimit(overrides.github, (value) => onSave("github", value)),
    linear: useLimit(overrides.linear, (value) => onSave("linear", value)),
    website: useLimit(overrides.website, (value) => onSave("website", value)),
    pdf: useLimit(overrides.pdf, (value) => onSave("pdf", value)),
  } satisfies Record<LinkPreviewCategory, ReturnType<typeof useLimit>>
  return (
    <SettingOverrideList
      aria-labelledby={settingIds("link-preview-types").label}
      options={TYPE_MODE_OPTIONS}
      selectLabel={(label) => `${label} previews`}
      disabled={disabled}
      items={LINK_PREVIEW_CATEGORIES.map((category) => {
        const limit = limits[category]
        const label = CATEGORY_LABELS[category]
        const countId = `link-preview-${category}-count`
        return {
          key: category,
          label,
          value: limit.mode,
          onValueChange: limit.choose,
          trailing:
            limit.mode === "count" ? (
              <NumberInput
                id={countId}
                field={limit}
                min={1}
                compact
                aria-label={`${label} previews, how many`}
                disabled={disabled}
              />
            ) : undefined,
          error: limit.invalid ? <NumberFieldError id={countId} min={1} /> : undefined,
        }
      })}
    />
  )
}

export function LinkPreviewSettings() {
  const { preferences, updatePreferences, isLoading } = usePreferences()
  const count = preferences?.linkPreviewOpenCount ?? DEFAULT_LINK_PREVIEW_OPEN_COUNT
  const globalLimit = preferences?.linkPreviewDefault === "collapsed" ? 0 : count
  const overrides = preferences?.linkPreviewTypeOverrides ?? {}
  async function save(input: Parameters<typeof updatePreferences>[0]) {
    try {
      await updatePreferences(input)
    } catch {
      /* The provider reports save failures. */
    }
  }

  return (
    <SettingsSection section="link-previews">
      <PreviewCountSetting
        value={globalLimit}
        disabled={isLoading}
        onSave={(value) =>
          void save(
            value === 0
              ? { linkPreviewDefault: "collapsed" }
              : { linkPreviewDefault: "open", linkPreviewOpenCount: value }
          )
        }
      />
      <SettingsDisclosure setting="link-preview-types" summary={overridesSummary(overrides)}>
        <TypeOverrides
          overrides={overrides}
          disabled={isLoading}
          onSave={(category, value) => {
            const next = { ...overrides }
            if (value === undefined) delete next[category]
            else next[category] = value
            void save({ linkPreviewTypeOverrides: next })
          }}
        />
      </SettingsDisclosure>
    </SettingsSection>
  )
}
