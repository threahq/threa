import { ARIADNE_PERSONA_SLUG, type PersonaListItem } from "@threahq/types"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PersonaListAvatar } from "@/components/persona-avatar"

/**
 * The fields the companion pickers render/resolve. Both the API roster's
 * `PersonaListItem` (settings surfaces) and the bootstrap-backed store rows
 * (`useCompanionRoster`) satisfy it, so every surface shares one picker.
 */
export type CompanionPersona = Pick<PersonaListItem, "id" | "slug" | "name" | "avatarEmoji" | "avatarUrl" | "kind">

export interface CompanionSelection {
  selectedPersonaId: string | undefined
  selectedPersona: CompanionPersona | undefined
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
  personas: CompanionPersona[] | undefined,
  companionPersonaId: string | null | undefined
): string {
  return companionPersonaId && personas?.some((p) => p.id === companionPersonaId)
    ? companionPersonaId
    : COMPANION_DEFAULT_OPTION_VALUE
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
  personas: CompanionPersona[] | undefined,
  companionPersonaId: string | null | undefined,
  defaultPersona?: CompanionPersona
): CompanionSelection {
  const fallback = defaultPersona ?? personas?.find((p) => p.slug === ARIADNE_PERSONA_SLUG)
  const pointed = companionPersonaId ? personas?.find((p) => p.id === companionPersonaId) : undefined
  const selectedPersona = pointed ?? fallback
  return { selectedPersonaId: selectedPersona?.id, selectedPersona, companionName: selectedPersona?.name ?? "Ariadne" }
}

/** Which persona rows get a default indicator: the workspace tier's resolution
 *  and the viewer's explicit personal default (when set). */
export interface CompanionDefaultBadges {
  workspaceDefaultId?: string
  personalDefaultId?: string
}

/** How each default tier reads beside a picker row. */
export const COMPANION_DEFAULT_TAGS = { personal: "Your default", workspace: "Workspace default" } as const

function defaultBadgeLabel(personaId: string, badges: CompanionDefaultBadges | undefined): string | null {
  if (!badges) return null
  // "Your default" is the more specific tier — it wins when both land on one row.
  if (badges.personalDefaultId === personaId) return COMPANION_DEFAULT_TAGS.personal
  if (badges.workspaceDefaultId === personaId) return COMPANION_DEFAULT_TAGS.workspace
  return null
}

/**
 * The muted suffixes a persona row carries: the default-tier indicator (if any)
 * and a "Personal" tag for a user-owned (kind `personal`) persona. Both are small
 * shrink-0 tags, so a personal persona that is also the viewer's default reads
 * "Your default · Personal" without wrapping (INV-21). Pure so the composition is
 * unit-testable independent of the Radix Select DOM.
 */
export function companionRowBadges(
  persona: Pick<CompanionPersona, "id" | "kind">,
  badges: CompanionDefaultBadges | undefined
): { defaultBadge: string | null; isPersonal: boolean } {
  return { defaultBadge: defaultBadgeLabel(persona.id, badges), isPersonal: persona.kind === "personal" }
}

interface CompanionAgentSelectProps {
  workspaceId: string
  personas: CompanionPersona[]
  value: string | undefined
  onChange: (personaId: string) => void
  disabled?: boolean
  triggerClassName?: string
  /**
   * A leading row that follows the default rather than pinning a persona: the
   * persona it resolves to now, tagged with its tier ("Workspace default"). It
   * carries {@link COMPANION_DEFAULT_OPTION_VALUE}, which the caller maps back
   * to null/unset. A created scratchpad is pinned to one persona and offers none.
   */
  defaultOption?: { persona: CompanionPersona | undefined; tag: string }
  /** Tags on the persona rows marking the workspace/personal defaults, for a picker without `defaultOption`, which names the default itself. */
  defaultBadges?: CompanionDefaultBadges
  /** The surrounding row's label; without one the trigger names itself. */
  "aria-labelledby"?: string
  "aria-describedby"?: string
}

/** The companion-agent dropdown shared by every surface that offers the picker:
 *  every row, the default one included, is avatar, name, then muted tags. */
export function CompanionAgentSelect({
  workspaceId,
  personas,
  value,
  onChange,
  disabled,
  triggerClassName,
  defaultOption,
  defaultBadges,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: CompanionAgentSelectProps) {
  // An empty roster means the store hasn't hydrated yet (built-ins guarantee a
  // real roster is never empty), so keep the trigger mounted at full size and
  // disable it instead of unmounting — a section that pops in after mount
  // shifts everything below it (INV-21). The value is withheld too: a draft's
  // synthetic default row would otherwise flash "Default (Ariadne)" before the
  // configured default resolves.
  const hydrating = personas.length === 0
  return (
    <Select value={hydrating ? undefined : value} onValueChange={onChange} disabled={disabled || hydrating}>
      <SelectTrigger
        className={triggerClassName}
        aria-label={labelledBy ? undefined : "Companion agent"}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
      >
        <SelectValue placeholder={hydrating ? "Loading agents…" : "Select an agent"} />
      </SelectTrigger>
      <SelectContent>
        {defaultOption && (
          <SelectItem value={COMPANION_DEFAULT_OPTION_VALUE}>
            <CompanionOption workspaceId={workspaceId} persona={defaultOption.persona} tags={[defaultOption.tag]} />
          </SelectItem>
        )}
        {personas.map((persona) => {
          const { defaultBadge, isPersonal } = companionRowBadges(persona, defaultBadges)
          return (
            <SelectItem key={persona.id} value={persona.id}>
              <CompanionOption
                workspaceId={workspaceId}
                persona={persona}
                tags={[defaultBadge, isPersonal ? "Personal" : null]}
              />
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

/** One picker row, as the trigger also shows it: avatar, name, muted tags that never wrap. */
function CompanionOption({
  workspaceId,
  persona,
  tags,
}: {
  workspaceId: string
  /** Unresolved while the roster loads: the row names Ariadne, the built-in default. */
  persona: CompanionPersona | undefined
  tags: readonly (string | null)[]
}) {
  return (
    <span className="flex items-center gap-2">
      {persona && <PersonaListAvatar workspaceId={workspaceId} persona={persona} size="xs" />}
      <span className="truncate">{persona?.name ?? "Ariadne"}</span>
      {tags.map(
        (tag) =>
          tag && (
            <span key={tag} className="shrink-0 text-xs text-muted-foreground">
              {tag}
            </span>
          )
      )}
    </span>
  )
}
