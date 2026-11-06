import { useId, useState } from "react"
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group"
import { ChevronRight } from "lucide-react"
import { WORKSPACE_PERMISSIONS, isApiKeyEligibleScope, type WorkspacePermissionSlug } from "@threahq/types"
import { cn } from "@/lib/utils"
import { SegmentedControl, SettingBadge, type ChoiceOption } from "@/components/settings/setting-primitives"
import { SettingCheckboxList } from "@/components/settings/setting-lists"
import {
  API_KEY_SCOPE_GROUPS,
  API_KEY_SCOPE_PRESETS,
  areaLevel,
  grantedAreas,
  groupLevel,
  matchingPreset,
  withAreaLevel,
  withGroupLevel,
  type AreaLevel,
  type ScopeArea,
  type ScopeAreaGroup,
  type ScopeLevel,
} from "./api-key-scopes"

const PERMISSIONS = new Map(WORKSPACE_PERMISSIONS.map((p) => [p.slug, p]))

const LEVEL_OPTIONS: readonly ChoiceOption<ScopeLevel>[] = [
  { value: "none", label: "None" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
]
const READ_ONLY_OPTIONS = LEVEL_OPTIONS.slice(0, 2)
const LEVEL_LABELS: Record<Exclude<AreaLevel, "none">, string> = { read: "Read", write: "Write", partial: "Some" }

/** Three equal columns, so every row's levels sit under the group's; a read-only area leaves the third empty. */
const LEVEL_COLUMNS = "grid w-48 shrink-0 grid-cols-3 sm:w-60"

type Scopes = ReadonlySet<WorkspacePermissionSlug>

interface PickerProps {
  scopes: Scopes
  onChange: (scopes: Set<WorkspacePermissionSlug>) => void
  disabled?: boolean
}

/**
 * The permissions of an API key, as areas a key can touch at None, Read or
 * Write, grouped, with presets on top. Each area opens to its individual
 * permissions. Permissions outside the picker's areas pass through untouched.
 */
export function ApiKeyPermissionPicker({ scopes, onChange, disabled = false }: PickerProps) {
  return (
    <div className="space-y-5">
      <PresetChips scopes={scopes} onChange={onChange} disabled={disabled} />
      {API_KEY_SCOPE_GROUPS.map((group) => (
        <GroupSection key={group.id} group={group} scopes={scopes} onChange={onChange} disabled={disabled} />
      ))}
    </div>
  )
}

function PresetChips({ scopes, onChange, disabled }: PickerProps) {
  const labelId = useId()
  const preset = matchingPreset(scopes)
  return (
    <RadioGroupPrimitive.Root
      aria-labelledby={labelId}
      value={preset?.id ?? ""}
      onValueChange={(id) => {
        const next = API_KEY_SCOPE_PRESETS.find((p) => p.id === id)
        if (next) onChange(new Set([...[...scopes].filter((slug) => !isApiKeyEligibleScope(slug)), ...next.scopes]))
      }}
      disabled={disabled}
      orientation="horizontal"
      className="flex flex-wrap gap-2"
    >
      <span id={labelId} className="sr-only">
        Presets
      </span>
      {API_KEY_SCOPE_PRESETS.map(({ id, label, icon: Icon }) => (
        <RadioGroupPrimitive.Item
          key={id}
          value={id}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-accent data-[state=checked]:shadow-[inset_0_0_0_1px_hsl(var(--primary))] motion-reduce:transition-none sm:min-h-8 [@media(pointer:coarse)]:min-h-11 [&[data-state=checked]>svg]:text-primary"
        >
          <Icon aria-hidden className="h-3.5 w-3.5 text-muted-foreground max-sm:hidden" />
          {label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  )
}

function GroupSection({ group, scopes, onChange, disabled }: PickerProps & { group: ScopeAreaGroup }) {
  const headingId = useId()
  const bulkId = useId()
  return (
    <section aria-labelledby={headingId}>
      <div className="flex min-h-9 items-center gap-3 border-b border-border/50 pb-1">
        <h3 id={headingId} className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {group.label}
        </h3>
        <span id={bulkId} className="sr-only">
          All {group.label}
        </span>
        <SegmentedControl
          aria-labelledby={bulkId}
          options={LEVEL_OPTIONS}
          value={groupLevel(group, scopes) ?? ""}
          onValueChange={(level) => onChange(withGroupLevel(scopes, group, level as ScopeLevel))}
          disabled={disabled}
          className={cn(LEVEL_COLUMNS, "bg-transparent")}
        />
      </div>
      <ul className="divide-y divide-border/50">
        {group.areas.map((area) => (
          <AreaRow key={area.id} area={area} scopes={scopes} onChange={onChange} disabled={disabled} />
        ))}
      </ul>
    </section>
  )
}

function AreaRow({ area, scopes, onChange, disabled }: PickerProps & { area: ScopeArea }) {
  const [open, setOpen] = useState(false)
  const labelId = useId()
  const panelId = useId()
  const level = areaLevel(area, scopes)
  const Icon = area.icon
  const slugs = [...area.read, ...area.write]
  return (
    <li>
      <div className="flex min-h-12 items-center gap-2 py-1 sm:gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors motion-reduce:transition-none",
              level === "none" ? "bg-muted text-muted-foreground" : "bg-accent text-primary"
            )}
          >
            <Icon aria-hidden className="h-4 w-4" />
          </span>
          <span id={labelId} className="truncate text-sm font-medium">
            {area.label}
          </span>
          {level === "partial" && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary">
              <span className="sr-only">, some permissions</span>
            </span>
          )}
          <ChevronRight
            aria-hidden
            className={cn(
              "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-90"
            )}
          />
        </button>
        <SegmentedControl
          aria-labelledby={labelId}
          options={area.write.length ? LEVEL_OPTIONS : READ_ONLY_OPTIONS}
          value={level === "partial" ? "" : level}
          onValueChange={(next) => onChange(withAreaLevel(scopes, area, next as ScopeLevel))}
          disabled={disabled}
          className={LEVEL_COLUMNS}
        />
      </div>
      {open && (
        <div id={panelId} className="pb-2 pl-10">
          <SettingCheckboxList
            aria-labelledby={labelId}
            bleed="inset"
            disabled={disabled}
            selected={scopes}
            items={slugs.map((slug) => ({
              value: slug,
              label: PERMISSIONS.get(slug)?.name ?? slug,
              description: PERMISSIONS.get(slug)?.description,
            }))}
            onCheckedChange={(slug, checked) => {
              const next = new Set(scopes)
              if (checked) next.add(slug)
              else next.delete(slug)
              onChange(next)
            }}
          />
        </div>
      )}
    </li>
  )
}

/**
 * What a key grants, at a glance: the preset it matches, else each area with
 * access at its level. Permissions no key can be granted show by name.
 */
export function ApiKeyScopeSummary({
  scopes,
  labels,
}: {
  scopes: readonly WorkspacePermissionSlug[]
  labels: Record<string, string>
}) {
  const held = new Set(scopes)
  const preset = matchingPreset(held)
  const others = scopes.filter((scope) => !isApiKeyEligibleScope(scope))
  return (
    <div className="flex flex-wrap gap-1.5">
      {preset ? (
        <SettingBadge icon={preset.icon} className="text-foreground">
          {preset.label}
        </SettingBadge>
      ) : (
        grantedAreas(held).map(({ area, level }) => (
          <SettingBadge key={area.id} icon={area.icon}>
            {area.label} · {LEVEL_LABELS[level]}
          </SettingBadge>
        ))
      )}
      {others.map((scope) => (
        <SettingBadge key={scope}>{labels[scope] ?? scope}</SettingBadge>
      ))}
    </div>
  )
}
