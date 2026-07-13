import { ARIADNE_PERSONA_SLUG, type PersonaListItem } from "@threa/types"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PersonaListAvatar } from "@/components/persona-avatar"

export interface CompanionSelection {
  selectedPersonaId: string | undefined
  selectedPersona: PersonaListItem | undefined
  /** Display name for copy ("… reads new messages and replies"). */
  companionName: string
}

/** Sentinel Select value for the synthetic "default" option: distinct from any
 *  `persona_…` id, round-trips as null (streams) / null-pref (user settings). */
export const COMPANION_DEFAULT_OPTION_VALUE = "__workspace_default__"

/**
 * Select value for a stream surface's picker: an explicit on-roster pointer
 * selects its persona row; anything else — null (inherit) or an off-roster
 * (archived) pointer that dispatch would degrade anyway — selects the synthetic
 * default row. Inherit is legible and picking a concrete persona always pins.
 */
export function companionPickerValue(
  personas: PersonaListItem[] | undefined,
  companionPersonaId: string | null | undefined
): string {
  return companionPersonaId && personas?.some((p) => p.id === companionPersonaId)
    ? companionPersonaId
    : COMPANION_DEFAULT_OPTION_VALUE
}

/** Label for the stream pickers' synthetic inherit row, naming the persona the
 *  default currently resolves to. */
export function companionDefaultOptionLabel(defaultPersona: PersonaListItem | undefined): string {
  return `Default (${defaultPersona?.name ?? "Ariadne"})`
}

/** Map a picker value back to the stored pointer: the synthetic inherit row
 *  round-trips as null; any other value is a concrete persona id (a pin). */
export function companionPointerFromPickerValue(value: string): string | null {
  return value === COMPANION_DEFAULT_OPTION_VALUE ? null : value
}

/**
 * Resolve a stream's companion-persona pointer against the roster. A null
 * pointer resolves to the effective default (user → workspace → Ariadne) at
 * dispatch, so the picker pre-selects that persona and mode copy names it. A
 * pointer to a persona missing from the roster (archived) degrades to the default
 * too — the returned id is the RESOLVED persona's, never the raw off-roster
 * pointer, so the Select trigger and the mode copy always agree.
 *
 * `defaultPersona` is the resolved default from `useDefaultCompanionPersona`; when
 * a caller can't supply one (roster-less states, tests), the Ariadne-slug lookup
 * inside stays the final fallback so behavior is byte-identical to before.
 */
export function resolveCompanionSelection(
  personas: PersonaListItem[] | undefined,
  companionPersonaId: string | null | undefined,
  defaultPersona?: PersonaListItem
): CompanionSelection {
  const fallback = defaultPersona ?? personas?.find((p) => p.slug === ARIADNE_PERSONA_SLUG)
  const pointed = companionPersonaId ? personas?.find((p) => p.id === companionPersonaId) : undefined
  const selectedPersona = pointed ?? fallback
  return { selectedPersonaId: selectedPersona?.id, selectedPersona, companionName: selectedPersona?.name ?? "Ariadne" }
}

interface CompanionAgentSelectProps {
  workspaceId: string
  personas: PersonaListItem[]
  value: string | undefined
  onChange: (personaId: string) => void
  disabled?: boolean
  triggerClassName?: string
  /** A leading synthetic option (e.g. "Workspace default (Ariadne)") rendered
   *  before the persona rows; it carries {@link COMPANION_DEFAULT_OPTION_VALUE},
   *  which the caller maps back to null. */
  defaultOption?: { label: string }
}

/** The companion-agent dropdown (avatar + name rows) shared by every surface
 *  that offers the picker, so option rendering can't drift between them. */
export function CompanionAgentSelect({
  workspaceId,
  personas,
  value,
  onChange,
  disabled,
  triggerClassName,
  defaultOption,
}: CompanionAgentSelectProps) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={triggerClassName} aria-label="Companion agent">
        <SelectValue placeholder="Select an agent" />
      </SelectTrigger>
      <SelectContent>
        {defaultOption && (
          <SelectItem value={COMPANION_DEFAULT_OPTION_VALUE}>
            <span className="truncate">{defaultOption.label}</span>
          </SelectItem>
        )}
        {personas.map((persona) => (
          <SelectItem key={persona.id} value={persona.id}>
            <span className="flex items-center gap-2">
              <PersonaListAvatar workspaceId={workspaceId} persona={persona} size="xs" />
              <span className="truncate">{persona.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
