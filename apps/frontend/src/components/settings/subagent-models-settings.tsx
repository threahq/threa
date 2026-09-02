import { DEFAULT_SUBAGENT_MODELS, SUBAGENT_MODEL_CATALOG } from "@threa/types"
import { usePreferences } from "@/contexts"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { modelDisplayName } from "@/lib/model-display"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"

/** The catalog's label and rates for a model id, or a derived label when it isn't listed. */
function describe(modelId: string): { label: string; price: string | null } {
  const entry = SUBAGENT_MODEL_CATALOG.find((candidate) => candidate.id === modelId)
  if (!entry) return { label: modelDisplayName(modelId), price: null }
  return {
    label: entry.label,
    price: `$${entry.inputPricePerMTok.toFixed(2)} in · $${entry.outputPricePerMTok.toFixed(2)} out per 1M tokens`,
  }
}

/**
 * The viewer's personal narrowing of the workspace's delegation models. A
 * subset, never an extension: the list offered is exactly what the workspace
 * allows, and storing every one of them stores nothing at all — an empty
 * preference means "follow the workspace", so a set the admin later widens
 * reaches a user who never narrowed it. Unticking the last box is allowed and
 * lands in exactly that state.
 *
 * Ticks derive from the STORED preference, never from the effective fallback:
 * when a stored subset no longer names a single model the workspace still
 * allows, resolution yields nothing and delegation is off for this user — an
 * honest empty picker plus a note, rather than a full set of ticks claiming a
 * permission they do not have. Hidden entirely when the workspace offers fewer
 * than two models; there is nothing to subset — unless a stale stored subset
 * has turned delegation off and a workspace model remains to re-pick, in which
 * case the picker stays as the only way out of that state.
 */
export function PersonalSubagentModelsSection({ workspaceId }: { workspaceId: string }) {
  const { preferences, updatePreference, isLoading } = usePreferences()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const workspaceSettings = bootstrap?.workspaceSettings ?? null
  // The shipped default stands in until the bootstrap resolves, so a mid-load
  // render never claims the workspace allows nothing (`FollowUpLimitSection`'s
  // `?? DEFAULT` shape); the boxes stay disabled until the real set arrives.
  const workspaceModels = workspaceSettings?.subagentModels ?? DEFAULT_SUBAGENT_MODELS
  const stored = preferences?.subagentModels ?? []

  const narrowed = workspaceModels.filter((id) => stored.includes(id))
  const hasSubset = stored.length > 0
  const selected = hasSubset ? narrowed : workspaceModels
  // A subset that survived the workspace dropping every model in it: resolution
  // returns nothing and the user gets no delegation at all until they re-pick.
  const delegationOff = hasSubset && narrowed.length === 0

  // With an empty workspace set delegation is off workspace-wide and no
  // preference edit can change that, so hiding stays honest there.
  const needsRecovery = delegationOff && workspaceModels.length > 0
  if (workspaceModels.length < 2 && !needsRecovery) return null

  const toggle = (modelId: string, next: boolean) => {
    const updated = new Set(selected)
    if (next) updated.add(modelId)
    else updated.delete(modelId)
    // Ordered on the workspace list, which also drops any stale id the stored
    // subset was still carrying. Every model ticked is the default: store nothing
    // rather than a list that would freeze this user out of a model the
    // workspace adds later — and an empty selection is that same default.
    const ordered = workspaceModels.filter((id) => updated.has(id))
    void updatePreference("subagentModels", ordered.length === workspaceModels.length ? [] : ordered)
  }

  // The separator belongs to the section, not the page: the section disappears
  // whole when the workspace has nothing to subset.
  return (
    <>
      <Separator />
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Subagent models</h3>
          <p className="text-sm text-muted-foreground">
            Which of your workspace&apos;s models an assistant may hand your work to as a subagent. Untick one to keep
            it out of your conversations; your workspace admin decides the list itself.
          </p>
        </div>
        <ul className="space-y-2">
          {workspaceModels.map((modelId) => {
            const { label, price } = describe(modelId)
            const checked = selected.includes(modelId)
            return (
              <li key={modelId} className="flex items-start gap-2.5">
                <Checkbox
                  id={`personal-subagent-model-${modelId}`}
                  className="mt-0.5"
                  checked={checked}
                  disabled={isLoading || workspaceSettings == null}
                  onCheckedChange={(value) => toggle(modelId, value === true)}
                />
                <div className="min-w-0">
                  <Label htmlFor={`personal-subagent-model-${modelId}`} className="text-sm font-normal">
                    {label}
                  </Label>
                  {price && <p className="text-xs text-muted-foreground">{price}</p>}
                </div>
              </li>
            )
          })}
        </ul>
        {workspaceSettings != null && delegationOff && (
          <p className="text-xs text-amber-700 dark:text-amber-500">
            None of the models you picked are in your workspace&apos;s set any more, so nothing can be delegated for you
            until you choose one above.
          </p>
        )}
        {!hasSubset && (
          <p className="text-xs text-muted-foreground">
            Following your workspace&apos;s set — models it adds later are available to you automatically.
          </p>
        )}
      </section>
    </>
  )
}
