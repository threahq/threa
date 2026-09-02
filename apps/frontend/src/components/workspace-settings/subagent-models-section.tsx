import {
  DEFAULT_SUBAGENT_MODELS,
  SUBAGENT_MODEL_CATALOG,
  WORKSPACE_PERMISSION_SCOPES,
  type SubagentModelCatalogEntry,
} from "@threa/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { hasPermission } from "@/lib/permissions"
import { modelDisplayName } from "@/lib/model-display"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

/** "$2.50 in · $15.00 out per 1M tokens" — the two rates a delegation is billed at. */
function formatPrice(entry: SubagentModelCatalogEntry): string {
  const rate = (value: number) => `$${value.toFixed(2)}`
  return `${rate(entry.inputPricePerMTok)} in · ${rate(entry.outputPricePerMTok)} out per 1M tokens`
}

/**
 * A row the picker offers. Catalog entries come first in catalog order; a model
 * stored by an earlier admin (or the API) that the catalog no longer lists is
 * appended as a checked row with no price, so unticking it stays possible and
 * saving an unrelated change can't silently drop it.
 */
function pickerRows(selected: string[]): Array<{ id: string; label: string; entry: SubagentModelCatalogEntry | null }> {
  const catalogIds = new Set(SUBAGENT_MODEL_CATALOG.map((entry) => entry.id))
  return [
    ...SUBAGENT_MODEL_CATALOG.map((entry) => ({ id: entry.id, label: entry.label, entry })),
    ...selected.filter((id) => !catalogIds.has(id)).map((id) => ({ id, label: modelDisplayName(id), entry: null })),
  ]
}

/**
 * Which models a persona may hand a subagent to (INV-33 — the same list the
 * `start_subagent` tool re-resolves against at execution, and the list a
 * built-in persona's escalation model must come from). Admin-editable; other
 * members see the set read-only, because it explains why a delegation they
 * asked for was refused.
 */
export function SubagentModelsSection({ workspaceId }: { workspaceId: string }) {
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const settings = bootstrap?.workspaceSettings ?? null
  // Show the shipped default until the bootstrap resolves — an unresolved
  // bootstrap is not the same claim as "this workspace allows nothing", and the
  // rows below say exactly that when the set is empty. Same `?? DEFAULT` shape
  // as `FollowUpLimitSection`; edits stay disabled until `settings` is real.
  const selected = settings?.subagentModels ?? DEFAULT_SUBAGENT_MODELS
  const rows = pickerRows(selected)

  const mutation = useWorkspaceSettingMutation(workspaceId, "subagentModels", "Failed to save the delegation models")

  // Toggling writes the whole list in the picker's own order (catalog first,
  // then anything stored the catalog dropped). Canonical order is what makes
  // untick-then-retick round-trip to the shipped default and actually elide the
  // override, instead of storing a permutation that only looks different.
  const toggle = (modelId: string, next: boolean) => {
    const updated = new Set(selected)
    if (next) updated.add(modelId)
    else updated.delete(modelId)
    mutation.mutate(rows.map((row) => row.id).filter((id) => updated.has(id)))
  }

  return (
    <div>
      <h3 className="text-sm font-medium">Subagent models</h3>
      <p className="text-xs text-muted-foreground mt-0.5">
        The models an assistant may hand a task to as a subagent, and the models a built-in persona may escalate to.
        Delegating spends the workspace&apos;s AI budget at the rates below.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map(({ id, label, entry }) => {
          const checked = selected.includes(id)
          return (
            <li key={id} className="flex items-start gap-2.5">
              <Checkbox
                id={`subagent-model-${id}`}
                className="mt-0.5"
                checked={checked}
                disabled={!canManage || settings == null || mutation.isPending}
                onCheckedChange={(value) => toggle(id, value === true)}
              />
              <div className="min-w-0">
                <Label htmlFor={`subagent-model-${id}`} className="text-sm font-normal">
                  {label}
                  {entry?.tier === "premium" && (
                    <span className="ml-2 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      Premium
                    </span>
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {entry ? formatPrice(entry) : "No longer offered — untick to drop it"}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
      {settings != null && selected.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          With nothing ticked, assistants cannot delegate to another model at all.
        </p>
      )}
    </div>
  )
}
