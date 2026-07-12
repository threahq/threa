import { ARIADNE_PERSONA_SLUG, type PersonaListItem } from "@threa/types"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PersonaListAvatar } from "@/components/persona-avatar"

export interface CompanionSelection {
  selectedPersonaId: string | undefined
  selectedPersona: PersonaListItem | undefined
  /** Display name for copy ("… reads new messages and replies"). */
  companionName: string
}

/**
 * Resolve a stream's companion-persona pointer against the roster. A null
 * pointer resolves to the built-in default (Ariadne) at dispatch, so the picker
 * pre-selects that persona and mode copy names it; a pointer to a persona
 * missing from the roster (archived) degrades the same way.
 */
export function resolveCompanionSelection(
  personas: PersonaListItem[] | undefined,
  companionPersonaId: string | null | undefined
): CompanionSelection {
  const defaultPersona = personas?.find((p) => p.slug === ARIADNE_PERSONA_SLUG)
  const selectedPersonaId = companionPersonaId ?? defaultPersona?.id
  const selectedPersona = personas?.find((p) => p.id === selectedPersonaId) ?? defaultPersona
  return { selectedPersonaId, selectedPersona, companionName: selectedPersona?.name ?? "Ariadne" }
}

interface CompanionAgentSelectProps {
  workspaceId: string
  personas: PersonaListItem[]
  value: string | undefined
  onChange: (personaId: string) => void
  disabled?: boolean
  triggerClassName?: string
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
}: CompanionAgentSelectProps) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={triggerClassName} aria-label="Companion agent">
        <SelectValue placeholder="Select an agent" />
      </SelectTrigger>
      <SelectContent>
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
