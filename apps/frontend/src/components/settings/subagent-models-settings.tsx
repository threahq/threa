import { DEFAULT_SUBAGENT_MODELS, SUBAGENT_MODEL_CATALOG } from "@threahq/types"
import { usePreferences } from "@/contexts"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { modelDisplayName } from "@/lib/model-display"
import { CircleAlert } from "lucide-react"
import { SettingNotice, SettingsDisclosure, settingIds } from "./setting-primitives"
import { SettingCheckboxList } from "./setting-lists"
import { SETTING_MUTED_NOTE_TEXT } from "./setting-text"

const LAST_MODEL_NOTE_ID = "personal-subagent-models-last"

/** The catalog's label and rates for a model id, or a derived label when it isn't listed. */
function describe(modelId: string): { label: string; price: string | null } {
  const entry = SUBAGENT_MODEL_CATALOG.find((candidate) => candidate.id === modelId)
  if (!entry) return { label: modelDisplayName(modelId), price: null }
  return {
    label: entry.label,
    price: `$${entry.inputPricePerMTok.toFixed(2)} in · $${entry.outputPricePerMTok.toFixed(2)} out per 1M tokens`,
  }
}

interface SubagentModelsState {
  selected: readonly string[]
  hasSubset: boolean
  /** A stored subset that no longer names a model the workspace allows: nothing can be delegated. */
  delegationOff: boolean
  /** Whether the picker shows at all. */
  available: boolean
}

/**
 * The viewer's personal narrowing of the workspace's delegation models. A
 * subset, never an extension: storing every model the workspace allows stores
 * nothing, since an empty preference means "follow the workspace", so a set
 * the admin later widens reaches a user who never narrowed it.
 *
 * Ticks derive from the STORED preference, never from the effective fallback:
 * a stored subset that no longer names a model the workspace allows leaves
 * delegation off, shown as an empty picker plus a note. The picker hides when
 * the workspace offers fewer than two models, unless that stale state needs a
 * workspace model re-picked; with no workspace models at all no edit helps.
 */
export function subagentModelsState(
  workspaceModels: readonly string[],
  stored: readonly string[]
): SubagentModelsState {
  const narrowed = workspaceModels.filter((id) => stored.includes(id))
  const hasSubset = stored.length > 0
  const delegationOff = hasSubset && narrowed.length === 0
  return {
    selected: hasSubset ? narrowed : workspaceModels,
    hasSubset,
    delegationOff,
    available: workspaceModels.length >= 2 || (delegationOff && workspaceModels.length > 0),
  }
}

export function PersonalSubagentModelsSection({ workspaceId }: { workspaceId: string }) {
  const { preferences, updatePreference, isLoading } = usePreferences()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const workspaceSettings = bootstrap?.workspaceSettings ?? null
  // The shipped default stands in until the bootstrap resolves, so a mid-load
  // render never claims the workspace allows nothing (`FollowUpLimitSection`'s
  // `?? DEFAULT` shape); the boxes stay disabled until the real set arrives.
  const workspaceModels = workspaceSettings?.subagentModels ?? DEFAULT_SUBAGENT_MODELS
  const { selected, hasSubset, delegationOff, available } = subagentModelsState(
    workspaceModels,
    preferences?.subagentModels ?? []
  )
  if (!available) return null

  const toggle = (modelId: string, next: boolean) => {
    const updated = new Set(selected)
    if (next) updated.add(modelId)
    else updated.delete(modelId)
    // Ordered on the workspace list, which also drops any stale id the stored
    // subset was still carrying. Every model ticked is the default: store nothing
    // rather than a list that would freeze this user out of a model the
    // workspace adds later.
    const ordered = workspaceModels.filter((id) => updated.has(id))
    void updatePreference("subagentModels", ordered.length === workspaceModels.length ? [] : ordered)
  }

  const ids = settingIds("subagent-models")
  let summary = "None picked"
  if (!hasSubset) summary = "Same as the workspace"
  else if (selected.length > 0) summary = selected.map((modelId) => describe(modelId).label).join(", ")
  return (
    <SettingsDisclosure setting="subagent-models" summary={summary}>
      <SettingCheckboxList
        aria-labelledby={ids.label}
        aria-describedby={ids.description}
        disabled={isLoading || workspaceSettings == null}
        selected={selected}
        onCheckedChange={toggle}
        items={workspaceModels.map((modelId) => {
          const { label, price } = describe(modelId)
          // An empty list means "every model", so the last tick can't come off.
          const onlyOne = selected.includes(modelId) && selected.length === 1
          return {
            value: modelId,
            label,
            description: price ?? undefined,
            disabled: onlyOne,
            describedBy: onlyOne ? LAST_MODEL_NOTE_ID : undefined,
          }
        })}
      />
      {workspaceSettings != null && delegationOff && (
        <SettingNotice icon={CircleAlert} role="status">
          None of the models you picked are in your workspace&apos;s set any more, so nothing can be delegated for you
          until you choose one above.
        </SettingNotice>
      )}
      {selected.length === 1 && !delegationOff && (
        <p id={LAST_MODEL_NOTE_ID} className={SETTING_MUTED_NOTE_TEXT}>
          Keep at least one model.
        </p>
      )}
    </SettingsDisclosure>
  )
}
