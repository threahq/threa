import { DEFAULT_SUBAGENT_MODELS, SUBAGENT_MODEL_CATALOG, type SubagentModelCatalogEntry } from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { modelDisplayName } from "@/lib/model-display"
import { badgeVariants } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { SettingsDisclosure, settingIds } from "@/components/settings/setting-primitives"
import { SettingCheckboxList } from "@/components/settings/setting-lists"
import { accessDescription, useWorkspaceAccess } from "./workspace-permission"

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
  const access = useWorkspaceAccess(workspaceId)
  const settings = useCachedWorkspaceBootstrap(workspaceId)?.workspaceSettings ?? null
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

  const allowedCount = rows.filter((row) => selected.includes(row.id)).length
  const summary =
    settings != null && allowedCount === 0
      ? "None allowed, so agents can't delegate to another model"
      : `${allowedCount} of ${rows.length} models allowed`

  return (
    <SettingsDisclosure
      setting="workspace-subagent-models"
      summary={summary}
      description={accessDescription("workspace-subagent-models", access)}
    >
      <SettingCheckboxList
        aria-labelledby={settingIds("workspace-subagent-models").label}
        disabled={!access.allowed || settings == null || mutation.isPending}
        selected={selected}
        onCheckedChange={toggle}
        items={rows.map(({ id, label, entry }) => ({
          value: id,
          label: (
            <>
              {label}
              {entry?.tier === "premium" && (
                <span className={cn(badgeVariants({ variant: "outline" }), "ml-2 align-middle")}>Premium</span>
              )}
            </>
          ),
          description: entry ? formatPrice(entry) : "No longer offered. Untick to drop it.",
        }))}
      />
    </SettingsDisclosure>
  )
}
