import { SUBAGENT_MODEL_CATALOG } from "@threa/types"
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
 * reaches a user who never narrowed it.
 *
 * The last ticked model can't be unticked: zero ticks IS the follow-the-
 * workspace state, so it would read as a refusal and behave as the opposite.
 * Hidden entirely when the workspace offers fewer than two models — there is
 * nothing to subset.
 */
export function PersonalSubagentModelsSection({ workspaceId }: { workspaceId: string }) {
  const { preferences, updatePreference, isLoading } = usePreferences()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const workspaceModels = bootstrap?.workspaceSettings?.subagentModels ?? []
  const stored = preferences?.subagentModels ?? []

  // A stored id the workspace has since dropped is not in the offered list, so
  // it neither renders nor counts — the same thing resolution does with it.
  const narrowed = stored.filter((id) => workspaceModels.includes(id))
  const selected = narrowed.length > 0 ? narrowed : workspaceModels

  if (workspaceModels.length < 2) return null

  const toggle = (modelId: string, next: boolean) => {
    const updated = next ? [...selected, modelId] : selected.filter((id) => id !== modelId)
    if (updated.length === 0) return
    // Every model ticked is the default: store nothing rather than a list that
    // would freeze this user out of a model the workspace adds later.
    const covers = workspaceModels.every((id) => updated.includes(id))
    void updatePreference("subagentModels", covers ? [] : workspaceModels.filter((id) => updated.includes(id)))
  }

  // The separator belongs to the section, not the page: the section disappears
  // whole when the workspace has nothing to subset.
  return (
    <>
      <Separator />
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Delegation models</h3>
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
                  disabled={isLoading || (checked && selected.length === 1)}
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
      </section>
    </>
  )
}
