import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  type ComponentPropsWithoutRef,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react"
import { Link } from "react-router-dom"
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group"
import {
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  Keyboard,
  Loader2,
  Lock,
  Monitor,
  MonitorSmartphone,
  Plus,
  Smartphone,
  TriangleAlert,
  User,
  Users,
  X,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { useOptionalSettings } from "@/contexts/settings-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { useCoarsePointer } from "@/hooks/use-pointer"
import {
  sectionAudience,
  sectionTitle,
  settingAnchorId,
  settingDef,
  settingsSectionHeadingId,
  upperFirst,
  type AnySettingId,
  type SettingAppliesOn,
  type SettingsAudience,
  type SettingsSectionId,
  type StreamSettingsSectionId,
} from "./settings-registry"
import { useCommittedInteger, type CommittedInteger, type SaveState } from "./committed-field"
import { SettingChangedMark, SettingTwinLink } from "./setting-relations"
import { SETTING_MUTED_NOTE_TEXT, SETTING_NOTE_TEXT, SETTING_SECTION_HEADING_TEXT } from "./setting-text"

/**
 * Element ids for one setting row. The control is labelled by the row's label
 * and described by its description, so every control announces what it sets
 * without visible copy repeated on the control itself.
 */
export function settingIds(anchor: string) {
  const base = settingAnchorId(anchor)
  return {
    row: base,
    label: `${base}-label`,
    description: `${base}-description`,
    control: `${base}-control`,
    reason: `${base}-reason`,
    notice: `${base}-notice`,
    scope: `${base}-scope`,
    error: `${base}-error`,
  }
}

/**
 * Width of a row's control column from `sm` up, and of a control that fills it
 * (select, input, picker), so those start at one edge and end at the other.
 * Buttons and segmented choices keep their content width at the column's end.
 */
export const SETTING_CONTROL_WIDTH = "w-full sm:w-72"

/**
 * Height of a single-line control: 44px on phones and on any touch screen,
 * 36px under a mouse from `sm` up.
 */
export const SETTING_CONTROL_HEIGHT = "h-11 sm:h-9 [@media(pointer:coarse)]:min-h-11"

/** A single-line control (select, input, picker trigger) in a row's right-hand column. */
export const SETTING_CONTROL_CLASS = `${SETTING_CONTROL_HEIGHT} ${SETTING_CONTROL_WIDTH}`

/** A note-size line led by an icon: the shared anatomy of reasons, notices and errors. */
function IconNoteLine({
  icon: Icon,
  id,
  role,
  className,
  children,
}: {
  icon: LucideIcon
  id?: string
  role?: "alert" | "status"
  className: string
  children: ReactNode
}) {
  return (
    <span id={id} role={role} className={cn("flex items-start gap-1.5", SETTING_NOTE_TEXT, className)}>
      <Icon aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </span>
  )
}

const REASON_TONE = "mt-1 font-medium text-foreground/80"

/**
 * Why a control can't be changed, shown beside it. Point the control's
 * `aria-describedby` at `id` (a row's description already is, when this sits in it).
 */
export function DisabledReason({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <IconNoteLine icon={Lock} id={id} className={REASON_TONE}>
      {children}
    </IconNoteLine>
  )
}

/** The look of a control that stays focusable while it can't be used (`aria-disabled`, beside a {@link DisabledReason}). */
export const INACTIVE_CONTROL_CLASS = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50"

/**
 * A setting that can't be changed right now: `reason` is its row's
 * {@link DisabledReason}, `value` how search and summaries read the same state.
 */
export interface SettingUnavailable {
  reason: string
  value: string
}

function notSetUpOnServer(feature: string): SettingUnavailable {
  return {
    reason: `${feature} isn't set up on this Threa server. Whoever runs the server can set it up.`,
    value: "Not set up on this server",
  }
}

/** Features the server needs configured before anyone can use them: the viewer can't, so the reason names who can. */
export const NOT_SET_UP_ON_SERVER = {
  analytics: notSetUpOnServer("Usage reporting"),
  push: notSetUpOnServer("Push"),
  github: notSetUpOnServer("The GitHub app"),
  linear: notSetUpOnServer("Linear"),
} as const

/**
 * Something to know before using a row, under its description in the reason's
 * place and style: `Info` by default, `CircleAlert` for a warning (`TriangleAlert` stays for errors). Through
 * `SettingRow`'s `notice` it gets `ids.notice`; `role="status"` when it appears
 * in response to a change.
 */
export function SettingNotice({
  id,
  icon = Info,
  role,
  children,
}: {
  id?: string
  icon?: LucideIcon
  role?: "status"
  children: ReactNode
}) {
  return (
    <IconNoteLine icon={icon} id={id} role={role} className={REASON_TONE}>
      {children}
    </IconNoteLine>
  )
}

/**
 * Holds a control's place while what decides it (such as the viewer's
 * permissions) is still loading, so it never shows disabled without a reason.
 */
export function SettingControlSkeleton({ className }: { className?: string }) {
  return <Skeleton aria-hidden data-slot="setting-control-skeleton" className={cn(SETTING_CONTROL_HEIGHT, className)} />
}

/**
 * The one add button for a list row, placed in the row's control slot: "New …"
 * when it creates the item (agent, bot, status), "Add …" when it picks an existing one (member, bot to a stream).
 */
export const SettingAddButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Button>>(
  function SettingAddButton({ children, className, ...props }, ref) {
    return (
      <Button
        ref={ref}
        type="button"
        variant="outline"
        size="sm"
        className={cn(SETTING_CONTROL_HEIGHT, className)}
        {...props}
      >
        <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
        {children}
      </Button>
    )
  }
)

/**
 * A list with nothing in it: one muted line in the body, where the list would be.
 * The row's own add button stays the way to add one. Whole-page and search empty
 * states in the shell keep their dashed box; rows never use one.
 */
export function SettingEmptyNote({ children }: { children: ReactNode }) {
  return <p className={SETTING_MUTED_NOTE_TEXT}>{children}</p>
}

/**
 * The inset of a field's text from its edge (its padding and border), given
 * to values in the control column from `sm` up, so a value's text starts where
 * a select's or an input's does. On phones a value sits under its label and
 * starts where the label does.
 */
const SETTING_VALUE_INSET = "sm:pl-[calc(0.75rem+1px)]"

/** Whether `element`'s text runs past its width, so an ellipsis cuts it. */
function useClipped(element: HTMLElement | null, text: ReactNode): boolean {
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    if (!element) return
    const measure = () => setClipped(element.scrollWidth > element.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, text])
  return clipped
}

/**
 * A value the viewer can read but not change, in a control's place: regular
 * weight on one line, cut off with an ellipsis at its column's edge, and
 * `placeholder`, muted, when there's nothing to show. A value cut off is a
 * button that opens to its whole text in place, for a click, a tap or the
 * keyboard alike.
 */
export function SettingValue({
  id,
  placeholder = "Not set",
  className,
  children,
}: {
  id?: string
  placeholder?: string
  className?: string
  children?: ReactNode
}) {
  const empty = children === null || children === undefined || children === "" || children === false
  const [text, setText] = useState<HTMLSpanElement | null>(null)
  const clipped = useClipped(text, children)
  const [whole, setWhole] = useState(false)
  const frame = cn(
    "block min-w-0 text-left text-sm",
    SETTING_VALUE_INSET,
    empty ? "text-muted-foreground" : "text-foreground",
    className
  )
  const content = (
    <span ref={setText} className={cn("block", whole ? "whitespace-normal break-words" : "truncate")}>
      {empty ? placeholder : children}
    </span>
  )
  if (!clipped && !whole) {
    return (
      <div id={id} data-setting-value="" className={frame}>
        {content}
      </div>
    )
  }
  return (
    <button
      id={id}
      type="button"
      data-setting-value=""
      aria-expanded={whole}
      onClick={() => setWhole((shown) => !shown)}
      className={cn(
        frame,
        "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
      )}
    >
      {content}
    </button>
  )
}

/**
 * More than one action in a row's control slot, such as two invite buttons:
 * from `sm` up they share each line of the control column, wrapping when they
 * don't fit; stacked full width on phones.
 */
export function SettingActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:[&>*]:grow">{children}</div>
}

/** The one way to remove an item from a list: a ghost X, always visible. `label` names what it removes. */
export const SettingRemoveButton = forwardRef<
  HTMLButtonElement,
  Omit<ComponentPropsWithoutRef<typeof Button>, "children" | "aria-label"> & { label: string }
>(function SettingRemoveButton({ label, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      className={cn(
        "size-11 shrink-0 text-muted-foreground hover:text-foreground sm:size-9 [@media(pointer:coarse)]:size-11",
        className
      )}
      {...props}
    >
      <X aria-hidden />
    </Button>
  )
})

type StateActionButton = Omit<ComponentPropsWithoutRef<typeof Button>, "variant" | "size" | "asChild"> & {
  children: ReactNode
}

/** An action that goes somewhere; `reloadDocument` for a server route such as an OAuth connect. */
type StateActionLink = {
  href: string
  reloadDocument?: boolean
  className?: string
  "aria-describedby"?: string
  children: ReactNode
}

/**
 * A state sentence with the action that changes it, in a row's body: text left
 * and an outline button filling the control column; on phones the text, then a
 * full-width button.
 * The action is a button, or a link styled as one when it has an `href`, and is
 * described by the sentence. `live` announces the sentence as it changes.
 */
export function SettingStateAction({
  id,
  children,
  action,
  live = false,
}: {
  /** The sentence's id, for another control in the row it also describes. */
  id?: string
  children: ReactNode
  action: StateActionButton | StateActionLink
  live?: boolean
}) {
  const generatedId = useId()
  const stateId = id ?? generatedId
  const describedBy = [stateId, action["aria-describedby"]].filter(Boolean).join(" ")
  const actionClass = cn("w-full shrink-0 sm:w-auto", SETTING_CONTROL_HEIGHT, action.className)
  let control: ReactNode
  if ("href" in action) {
    control = (
      <Button variant="outline" size="sm" className={actionClass} asChild>
        <Link to={action.href} reloadDocument={action.reloadDocument} aria-describedby={describedBy}>
          {action.children}
        </Link>
      </Button>
    )
  } else {
    const { className: _className, "aria-describedby": _describedBy, ...button } = action
    control = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-describedby={describedBy}
        className={actionClass}
        {...button}
      />
    )
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <p id={stateId} aria-live={live ? "polite" : undefined} className={SETTING_MUTED_NOTE_TEXT}>
        {children}
      </p>
      {control}
    </div>
  )
}

const AUDIENCE_MARKERS: Record<SettingsAudience, { icon: LucideIcon; label: string }> = {
  you: { icon: User, label: "Only you" },
  everyone: { icon: Users, label: "Everyone here" },
}

/** Who changes reach: beside a section's title, or beside each row's label where a read-only section mixes them. */
export function AudienceBadge({ audience }: { audience: SettingsAudience }) {
  return <SettingBadge icon={AUDIENCE_MARKERS[audience].icon}>{AUDIENCE_MARKERS[audience].label}</SettingBadge>
}

export function SettingsSection({
  section,
  children,
  aside,
}: {
  section: SettingsSectionId | StreamSettingsSectionId
  children: ReactNode
  /** Rendered beside the title, such as a section-wide reset. */
  aside?: ReactNode
}) {
  const headingId = settingsSectionHeadingId(section)
  const title = sectionTitle(section)
  const audience = sectionAudience(section)
  const audienceId = `${headingId}-audience`
  return (
    <section aria-labelledby={headingId} aria-describedby={audience ? audienceId : undefined} className="space-y-2">
      <div className="flex min-h-6 items-end justify-between gap-3">
        <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
          <h3
            id={headingId}
            tabIndex={-1}
            className={cn(
              "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
              SETTING_SECTION_HEADING_TEXT
            )}
          >
            {title}
          </h3>
          {audience && (
            <span id={audienceId} data-audience={audience}>
              <AudienceBadge audience={audience} />
            </span>
          )}
        </div>
        {aside}
      </div>
      <div className="divide-y divide-border rounded-lg border bg-card">{children}</div>
    </section>
  )
}

/**
 * The one badge in settings: an attribute of what it sits on, such as its
 * scope ("This device", "Only you"), a role ("Owner") or a state ("Built-in").
 * Scope and audience sit beside a section's title, device-ness beside a row's
 * label, item attributes after an item's name.
 */
export function SettingBadge({
  icon: Icon,
  className,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<"span">, "children"> & { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-xs font-medium leading-4 text-muted-foreground",
        className
      )}
      {...props}
    >
      {Icon && <Icon className="h-3 w-3" aria-hidden />}
      {children}
    </span>
  )
}

interface ScopeContext {
  /** The primary pointer is touch. */
  touchOnly: boolean
  /** This device uses the phone layout. */
  phoneLayout: boolean
}

function useScopeContext(): ScopeContext {
  return { touchOnly: useCoarsePointer(), phoneLayout: useIsMobile() }
}

function scopeBadgesShown(
  device: boolean | undefined,
  appliesOn: SettingAppliesOn | undefined,
  { touchOnly, phoneLayout }: ScopeContext
) {
  return (
    !!device ||
    appliesOn === "phones" ||
    (appliesOn === "keyboards" && touchOnly) ||
    (appliesOn === "desktop" && phoneLayout)
  )
}

/**
 * "This device" for settings that don't follow the account; "Phones" for ones
 * that only act there. The rest show only where the setting would otherwise
 * read as broken: "Keyboards" (needs a hardware keyboard) on touch-only
 * devices, "Desktop layout" while this device uses the phone layout.
 */
export function SettingScopeBadges({
  device,
  appliesOn,
  id,
}: {
  device?: boolean
  appliesOn?: SettingAppliesOn
  /** For a control's `aria-describedby`, so the scope is announced with it. */
  id?: string
}) {
  const context = useScopeContext()
  if (!scopeBadgesShown(device, appliesOn, context)) return null
  return (
    <span id={id} className="inline-flex flex-wrap items-center gap-2">
      {device && <SettingBadge icon={MonitorSmartphone}>This device</SettingBadge>}
      {appliesOn === "phones" && <SettingBadge icon={Smartphone}>Phones</SettingBadge>}
      {appliesOn === "keyboards" && context.touchOnly && <SettingBadge icon={Keyboard}>Keyboards</SettingBadge>}
      {appliesOn === "desktop" && context.phoneLayout && <SettingBadge icon={Monitor}>Desktop layout</SettingBadge>}
    </span>
  )
}

function SettingMarks({ setting }: { setting: AnySettingId }) {
  const def = settingDef(setting)
  return (
    <>
      <SettingChangedMark setting={setting} />
      <SettingScopeBadges device={def.device} appliesOn={def.appliesOn} id={settingIds(setting).scope} />
    </>
  )
}

/**
 * The `aria-describedby` for a setting's own control: its description when it
 * has one, its scope badges when they show, then `extra` ids.
 */
export function useSettingDescribedBy(
  setting: AnySettingId,
  {
    description = !!settingDef(setting).description,
    extra = [],
  }: { description?: boolean; extra?: (string | false | null | undefined)[] } = {}
): string | undefined {
  const def = settingDef(setting)
  const ids = settingIds(setting)
  const scoped = scopeBadgesShown(def.device, def.appliesOn, useScopeContext())
  return [description && ids.description, scoped && ids.scope, ...extra].filter(Boolean).join(" ") || undefined
}

/** Rows that refine `parent`, grouped beneath it in its card and named by it. */
export function SettingDependents({ parent, children }: { parent: AnySettingId; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-labelledby={settingIds(parent).label}
      data-dependents-of={parent}
      className="divide-y divide-border"
    >
      {children}
    </div>
  )
}

/**
 * Props for an element a `?setting=` link lands on. The shell focuses it by
 * code, and a ring stays while it holds that focus; a click into the row's
 * blank space focuses it too, but draws no ring.
 */
export const landingTargetProps = {
  tabIndex: -1,
  onPointerDown: (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.dataset.pointerFocus = "true"
  },
  onPointerUp: (event: PointerEvent<HTMLElement>) => {
    delete event.currentTarget.dataset.pointerFocus
  },
  onFocus: (event: FocusEvent<HTMLElement>) => {
    const row = event.currentTarget
    if (event.target !== row || row.dataset.pointerFocus) return
    row.dataset.landed = "true"
  },
  onBlur: (event: FocusEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) delete event.currentTarget.dataset.landed
  },
} as const

export const LANDING_TARGET_CLASS =
  "scroll-mt-6 outline-none transition-colors duration-700 data-[highlighted=true]:bg-primary/10 data-[landed=true]:ring-2 data-[landed=true]:ring-inset data-[landed=true]:ring-ring motion-reduce:transition-none"

interface SettingRowLayoutProps {
  /**
   * The control slot: a fixed column beside the text from `sm` up, so a card's
   * controls share their edges, and under the text on phones. A button or link
   * placed directly in it fills it (switches stay at the row's end). A row's
   * add button goes here too, above its list.
   */
  control?: ReactNode
  /** The row body, under the text: lists, editors, radio lists, previews. */
  children?: ReactNode
  /**
   * `control` sits under the description at full width on every screen, for a
   * single field that is the row's whole content. Has no effect without
   * `control`; lists and editors go in `children`, and an add button stays in
   * the control slot without `stacked`.
   */
  stacked?: boolean
  /** Label targets `ids.control` with `htmlFor` (default for a registry setting or an `anchor`); off for groups, which use `aria-labelledby`. */
  labelFor?: boolean
  /**
   * A switch row: the control stays beside the text on phones too, and the
   * whole text block is its label, so tapping anywhere on it toggles. The
   * control must name itself with `aria-labelledby` (the label block also
   * holds the description).
   */
  toggle?: boolean
  /**
   * Why the row does nothing right now, such as its parent setting being off.
   * Shown under the description as `ids.reason`; the control stays focusable
   * with `aria-disabled` and points `aria-describedby` at the reason.
   */
  inactive?: ReactNode
  /** Something to know before using it, as a {@link SettingNotice} under the description (`ids.notice`). */
  notice?: ReactNode
  /** The notice's icon: `CircleAlert` for a warning. */
  noticeIcon?: LucideIcon
}

type SettingRowProps = SettingRowLayoutProps &
  (
    | {
        setting: AnySettingId
        /** Copy that depends on state, replacing the registry description. */
        description?: ReactNode
      }
    | {
        /**
         * A row about one thing rather than a registry setting, such as a bot's
         * picture: named here, so search and `?setting=` links don't reach it.
         */
        label: ReactNode
        description?: ReactNode
        /** Base of the row's ids (`settingIds(anchor)`), so its control can point at them. */
        anchor?: string
        /** `?setting=` links land on the row by `anchor`, as on one shortcut. */
        landing?: boolean
        /** Beside the label, such as a changed mark. */
        marks?: ReactNode
      }
  )

export function SettingRow(props: SettingRowProps) {
  const { control, children, stacked = false, description, toggle = false, inactive, notice, noticeIcon } = props
  const generatedAnchor = useId()
  const setting = "setting" in props ? props.setting : null
  const anchor = "anchor" in props ? props.anchor : undefined
  const def = setting ? settingDef(setting) : null
  const ids = settingIds(setting ?? anchor ?? generatedAnchor)
  const label = def ? def.label : (props as { label: ReactNode }).label
  const labelFor = props.labelFor ?? (setting !== null || anchor !== undefined)
  const shownDescription = description ?? def?.description
  const landingAnchor = setting ?? ("landing" in props && props.landing ? anchor : undefined)
  const marks = setting ? <SettingMarks setting={setting} /> : "marks" in props && props.marks
  const heading = (
    <span className="flex flex-wrap items-center gap-2">
      <span id={ids.label} className="text-sm font-medium leading-snug">
        {label}
      </span>
      {marks}
    </span>
  )
  const descriptionText = (
    <>
      {shownDescription && (
        <span id={ids.description} className={cn("block text-muted-foreground", SETTING_NOTE_TEXT)}>
          {shownDescription}
        </span>
      )}
      {inactive && <DisabledReason id={ids.reason}>{inactive}</DisabledReason>}
      {notice && (
        <SettingNotice id={ids.notice} icon={noticeIcon}>
          {notice}
        </SettingNotice>
      )}
      {setting && <SettingTwinLink setting={setting} />}
    </>
  )

  let text: ReactNode
  if (toggle) {
    text = (
      <Label
        htmlFor={ids.control}
        className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center gap-1 font-normal sm:min-h-0 [@media(pointer:coarse)]:min-h-11"
      >
        {heading}
        {descriptionText}
      </Label>
    )
  } else {
    text = (
      <div className="min-w-0 flex-1 space-y-1">
        {labelFor ? (
          <span className="flex flex-wrap items-center gap-2">
            <Label id={ids.label} htmlFor={ids.control} className="cursor-pointer leading-snug">
              {label}
            </Label>
            {marks}
          </span>
        ) : (
          heading
        )}
        {descriptionText}
      </div>
    )
  }

  let layout = "flex-col sm:flex-row sm:items-center sm:justify-between"
  if (stacked) layout = "flex-col"
  else if (toggle) layout = "flex-row items-center justify-between"

  const rowProps = landingAnchor
    ? {
        id: ids.row,
        "data-setting": landingAnchor,
        ...landingTargetProps,
        className: cn("px-4 py-3 first:rounded-t-lg last:rounded-b-lg", LANDING_TARGET_CLASS),
      }
    : { className: "px-4 py-3 first:rounded-t-lg last:rounded-b-lg" }

  return (
    <div {...rowProps}>
      <div className={cn("flex gap-x-4 gap-y-3", layout)}>
        {text}
        {control && (
          <div
            data-setting-control={toggle || stacked ? undefined : ""}
            className={cn(
              "shrink-0",
              stacked && "w-full",
              !toggle && !stacked && cn(SETTING_CONTROL_WIDTH, "flex flex-col sm:items-end")
            )}
          >
            {control}
          </div>
        )}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}

type SettingLinkRowProps = {
  /** Where the row goes; `null` keeps the same row, unlinked, when the viewer can't go there. */
  href: string | null
  /** The current value, in the control column from `sm` up and under the text on phones. */
  value?: ReactNode
  /** A one-line excerpt of long text, under the label, cut off at the row's edge. */
  preview?: ReactNode
  /** Tighter, for lists outside a settings card such as the agent panel. */
  compact?: boolean
} & (
  | {
      /** A setting whose purpose is another place: label, description and anchor from the registry. */
      setting: AnySettingId
      /** Copy that depends on state, replacing the registry description. */
      description?: ReactNode
    }
  | {
      /** An item of a list of places, named here rather than in the registry. */
      label: ReactNode
      /** A meta line under the label, such as who edits it. */
      description?: ReactNode
    }
)

/**
 * A row's chevron, › to go elsewhere or ⌄ to open in place: inset from the
 * row's end by a select's padding, so it shares the x of every select's ⌄.
 */
export const SETTING_ROW_CHEVRON_CLASS = "mr-3 h-4 w-4 shrink-0 text-muted-foreground"

/**
 * The inside of a row that goes elsewhere or opens in place: its text, then its
 * current value with the chevron at the control column's end, the value's text
 * on one line where a select's starts, cut off at the chevron. The whole value
 * stays in the row's name, and the place the row leads to shows it in full. On
 * phones, and in `compact` rows, the value and chevron go under the text.
 * Without a value the chevron ends the row.
 */
export function SettingValueRowBody({
  text,
  value,
  chevron,
  compact = false,
}: {
  text: ReactNode
  value?: ReactNode
  chevron: ReactNode
  compact?: boolean
}) {
  if (value === undefined) {
    return (
      <>
        <span className="min-w-0 flex-1">{text}</span>
        {chevron}
      </>
    )
  }
  return (
    <span className={cn("flex min-w-0 flex-1 flex-col gap-x-4 gap-y-0.5", !compact && "sm:flex-row sm:items-center")}>
      <span className="min-w-0 flex-1">{text}</span>
      <span
        data-setting-control={compact ? undefined : ""}
        className={cn("flex shrink-0 items-center gap-3", compact ? "w-full" : SETTING_CONTROL_WIDTH)}
      >
        <span
          data-setting-value=""
          className={cn("min-w-0 flex-1 truncate text-sm text-foreground", !compact && SETTING_VALUE_INSET)}
        >
          {value}
        </span>
        {chevron}
      </span>
    </span>
  )
}

/**
 * A row whose purpose is another place: label and description, its value in
 * the control column, a chevron at the end. The whole row is the link, so it
 * navigates and never acts.
 */
export function SettingLinkRow(props: SettingLinkRowProps) {
  const { href, value, preview, compact = false } = props
  const setting = "setting" in props ? props.setting : null
  const def = setting ? settingDef(setting) : null
  const label = "label" in props ? props.label : def?.label
  const description = props.description ?? def?.description

  const body = (
    <SettingValueRowBody
      compact={compact}
      value={value}
      text={
        <>
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium leading-snug">{label}</span>
            {setting && <SettingMarks setting={setting} />}
          </span>
          {description && (
            <span className={cn("mt-0.5 block text-muted-foreground", SETTING_NOTE_TEXT)}>{description}</span>
          )}
          {preview && <span className="mt-0.5 block min-w-0 truncate text-sm text-foreground">{preview}</span>}
        </>
      }
      chevron={
        href ? (
          <ChevronRight className={SETTING_ROW_CHEVRON_CLASS} aria-hidden />
        ) : (
          <span className={SETTING_ROW_CHEVRON_CLASS} aria-hidden />
        )
      }
    />
  )
  const layout = cn(
    "flex min-h-11 w-full items-center gap-3 text-left",
    compact ? "rounded-md px-2 py-1.5" : "rounded-[inherit] px-4 py-3"
  )
  const row = href ? (
    <Link
      to={href}
      className={cn(
        layout,
        "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={layout}>{body}</div>
  )
  if (!setting) return row
  return (
    <div
      id={settingIds(setting).row}
      data-setting={setting}
      {...landingTargetProps}
      className={cn("first:rounded-t-lg last:rounded-b-lg", LANDING_TARGET_CLASS)}
    >
      {row}
    </div>
  )
}

/** The in-card group band's look, for surfaces that can't use {@link SettingGroupBand}'s heading, such as a listbox. */
export const SETTING_GROUP_BAND_CLASS = "bg-muted/40 px-4 py-1.5 text-xs font-medium text-muted-foreground"

/**
 * A named group of rows inside one card, such as a shortcut category: a band
 * heading, then the rows, each a direct row of the card. Not a section, so not uppercase.
 */
export function SettingGroupBand({ label, children }: { label: ReactNode; children: ReactNode }) {
  const headingId = useId()
  return (
    <div role="group" aria-labelledby={headingId} className="divide-y divide-border [&:first-child>h4]:rounded-t-lg">
      <h4 id={headingId} className={SETTING_GROUP_BAND_CLASS}>
        {label}
      </h4>
      {children}
    </div>
  )
}

/**
 * Two or three short, mutually exclusive options as one radio group: arrow
 * keys move between them, Tab leaves the group. Name it with
 * `aria-labelledby`. It fills its width in segments sized to their labels,
 * each on one line; segments that can't fit side by side wrap to a second row.
 */
export function SegmentedControl<T extends string>({
  options,
  onValueChange,
  className,
  ...props
}: {
  options: readonly ChoiceOption<T>[]
  value: T
  onValueChange: (value: string) => void
  id?: string
  disabled?: boolean
  className?: string
  "aria-labelledby": string
  "aria-describedby"?: string
}) {
  return (
    <RadioGroupPrimitive.Root
      {...props}
      onValueChange={onValueChange}
      orientation="horizontal"
      className={cn("flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.5", className)}
    >
      {options.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          className="min-h-11 flex-1 basis-auto whitespace-nowrap rounded-md border border-transparent px-2 text-sm font-medium text-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-foreground/40 data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm motion-reduce:transition-none sm:min-h-8 sm:px-3 [@media(pointer:coarse)]:min-h-11"
        >
          {option.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  )
}

/**
 * One option of a radio list. The label stretches over the whole highlighted
 * box, so a tap anywhere on it picks the option; `trailing`, such as a value to
 * fill in with its own name, sits above that stretch and outside the label, so
 * it stays its own control. Editing `trailing` picks the option (`onPick`, given
 * while another is chosen), so the value typed is always the one in effect;
 * tabbing through it changes nothing.
 */
function ChoiceOptionRow({
  id,
  value,
  label,
  description,
  trailing,
  onPick,
}: {
  id: string
  value: string
  label: string
  description?: string
  trailing?: ReactNode
  onPick?: () => void
}) {
  return (
    <div className="relative grid min-h-11 content-center gap-0.5 rounded-md border border-transparent px-3 py-2.5 transition-colors hover:bg-muted/60 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary/5 has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-ring has-[[role=radio]:disabled]:opacity-60 motion-reduce:transition-none">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label
          htmlFor={id}
          className="flex cursor-pointer items-center gap-3 after:absolute after:inset-0 after:rounded-md has-[:disabled]:cursor-not-allowed"
        >
          <RadioGroupItem
            id={id}
            value={value}
            className="shrink-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            aria-labelledby={`${id}-label`}
            aria-describedby={description ? `${id}-description` : undefined}
          />
          <span id={`${id}-label`} className="text-sm font-medium leading-snug">
            {label}
          </span>
        </label>
        {trailing && (
          <div className="relative z-10" onChange={onPick}>
            {trailing}
          </div>
        )}
      </div>
      {description && (
        <span id={`${id}-description`} className={cn("pl-7 text-muted-foreground", SETTING_NOTE_TEXT)}>
          {description}
        </span>
      )}
    </div>
  )
}

export interface ChoiceOption<T extends string> {
  value: T
  label: string
  description?: string
  /** In a radio list, a field after the label that the option carries, such as its count. */
  trailing?: ReactNode
}

interface ChoiceSettingProps<T extends string> {
  setting: AnySettingId
  value: T
  options: readonly ChoiceOption<T>[]
  onValueChange: (value: T) => void
  /**
   * `segmented` for two or three short labels, shown as a select instead when
   * they wouldn't fit the control column on one line; `select` for more options. Both show the chosen option's description as the row's one
   * description, in place of the registry's when it has one. `list`
   * lays every option out with its description, for choices worth comparing
   * side by side; it's the default when options carry descriptions.
   */
  variant?: "segmented" | "select" | "list"
  /**
   * A select's option descriptions under each option in its list rather than
   * the chosen one under the row's description, for options that each need
   * their own, such as saved views' filters.
   */
  optionDescriptionsInMenu?: boolean
  disabled?: boolean
  /** What decides whether it can be changed is still loading: the control is a placeholder. */
  loading?: boolean
  description?: ReactNode
  /** The row body under the control, such as a preview of the choice. */
  children?: ReactNode
}

export function ChoiceSetting<T extends string>({
  setting,
  value,
  options,
  onValueChange,
  variant = options.some((option) => option.description) ? "list" : "segmented",
  optionDescriptionsInMenu = false,
  disabled,
  loading = false,
  description,
  children,
}: ChoiceSettingProps<T>) {
  const ids = settingIds(setting)
  const inMenu = variant === "select" && optionDescriptionsInMenu
  const chosen =
    variant === "list" || inMenu ? undefined : options.find((option) => option.value === value)?.description
  const baseDescription = description ?? settingDef(setting).description
  const shownDescription =
    chosen && baseDescription ? (
      <>
        {baseDescription}
        <span className="mt-0.5 block">{chosen}</span>
      </>
    ) : (
      (chosen ?? baseDescription)
    )
  const describedBy = useSettingDescribedBy(setting, { description: !!shownDescription })
  const groupProps = {
    id: ids.control,
    value,
    disabled,
    onValueChange: (next: string) => onValueChange(next as T),
    "aria-labelledby": ids.label,
    "aria-describedby": describedBy,
  }

  if (loading) {
    return (
      <SettingRow
        setting={setting}
        labelFor={false}
        description={baseDescription}
        stacked={variant === "list"}
        control={<SettingControlSkeleton className={variant === "list" ? "h-24 w-full" : SETTING_CONTROL_WIDTH} />}
      />
    )
  }

  if (variant === "segmented") {
    return (
      <SettingRow
        setting={setting}
        labelFor={false}
        description={shownDescription}
        control={<SegmentedControl {...groupProps} options={options} />}
      >
        {children}
      </SettingRow>
    )
  }

  if (variant === "select") {
    return (
      <SettingRow
        setting={setting}
        labelFor={false}
        description={shownDescription}
        control={
          <Select value={value} disabled={disabled} onValueChange={groupProps.onValueChange}>
            <SelectTrigger
              id={ids.control}
              aria-labelledby={ids.label}
              aria-describedby={groupProps["aria-describedby"]}
              className={SETTING_CONTROL_CLASS}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  description={inMenu ? option.description : undefined}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {children}
      </SettingRow>
    )
  }

  return (
    <SettingRow setting={setting} labelFor={false} description={description} stacked>
      <RadioGroup {...groupProps} className="gap-1.5">
        {options.map((option) => (
          <ChoiceOptionRow
            key={option.value}
            id={`${ids.control}-${option.value}`}
            value={option.value}
            label={option.label}
            description={option.description}
            trailing={option.trailing}
            onPick={option.value === value ? undefined : () => onValueChange(option.value)}
          />
        ))}
      </RadioGroup>
      {children && <div className="mt-3">{children}</div>}
    </SettingRow>
  )
}

export function SwitchSetting({
  setting,
  checked,
  onCheckedChange,
  disabled,
  inactive,
  loading = false,
  description,
  notice,
  noticeIcon,
  error,
  children,
}: {
  setting: AnySettingId
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Busy, such as while a change is on its way; for a setting that can't be changed, give `inactive`. */
  disabled?: boolean
  /**
   * Why it can't be changed right now, as the row's reason line. The switch
   * stays in the Tab order, `aria-disabled` and described by the reason, so a
   * keyboard user reaches the reason too.
   */
  inactive?: ReactNode
  /** Something to know about its current value, under its description; the switch is described by it. */
  notice?: ReactNode
  noticeIcon?: LucideIcon
  /** Why the last change wasn't saved, as the row's {@link SettingFieldError}; the switch is described by it. */
  error?: ReactNode
  /** What decides whether it can be changed is still loading: the switch is a placeholder. */
  loading?: boolean
  description?: ReactNode
  children?: ReactNode
}) {
  const ids = settingIds(setting)
  const describedBy = useSettingDescribedBy(setting, {
    description: description !== undefined || !!settingDef(setting).description,
    extra: [!!inactive && ids.reason, !!notice && ids.notice, !!error && ids.error],
  })
  const body =
    error || children ? (
      <div className="space-y-3">
        {error && <SettingFieldError id={ids.error}>{error}</SettingFieldError>}
        {children}
      </div>
    ) : null
  return (
    <SettingRow
      setting={setting}
      description={description}
      inactive={inactive}
      notice={notice}
      noticeIcon={noticeIcon}
      toggle
      control={
        loading ? (
          <SettingControlSkeleton className="h-6 w-11 rounded-full sm:h-6 [@media(pointer:coarse)]:min-h-0" />
        ) : (
          <Switch
            id={ids.control}
            checked={checked}
            disabled={disabled}
            aria-disabled={inactive ? true : undefined}
            onCheckedChange={inactive ? undefined : onCheckedChange}
            aria-labelledby={ids.label}
            aria-describedby={describedBy}
            className={INACTIVE_CONTROL_CLASS}
          />
        )
      }
    >
      {body}
    </SettingRow>
  )
}

/**
 * Why something wasn't saved or didn't work, directly under the control that
 * failed (under the body for list and stacked rows). Point the control's
 * `aria-describedby` or `aria-errormessage` at `id`.
 */
export function SettingFieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <IconNoteLine icon={TriangleAlert} id={id} role="alert" className="text-destructive">
      {children}
    </IconNoteLine>
  )
}

/**
 * Fixed text joined to a field's start or end inside one frame, such as
 * "github.com/" or a unit, so the pair fills the width the field alone would.
 * Round the field's joined side off (`rounded-l-none` / `rounded-r-none`).
 */
export function FieldAddon({
  side,
  className,
  ...props
}: ComponentPropsWithoutRef<"span"> & { side: "start" | "end" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center border border-input bg-muted px-3 text-sm text-foreground/70",
        side === "start" ? "rounded-l-md border-r-0" : "rounded-r-md border-l-0",
        className
      )}
      {...props}
    />
  )
}

interface NumberInputProps {
  id: string
  field: CommittedInteger
  min: number
  /** Omit for no upper bound. */
  max?: number
  unit?: string
  /** The field's own width, for one inline in a sentence such as "First [3]", instead of filling its slot. */
  compact?: boolean
  disabled?: boolean
  "aria-label"?: string
  "aria-labelledby"?: string
  "aria-describedby"?: string
}

const numberErrorId = (id: string) => `${id}-error`

/**
 * The input of a bounded whole number, `field` from `useCommittedInteger`
 * driving it: its unit joined to its end and its range announced with it. As
 * wide as a few digits, at its column's end from `sm` up; `compact` sits
 * inline instead. Show {@link NumberFieldError} while `field.invalid`.
 */
export function NumberInput({
  id,
  field,
  min,
  max,
  unit,
  compact = false,
  disabled,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: NumberInputProps) {
  const unitId = `${id}-unit`
  const rangeId = `${id}-range`
  return (
    <div className={cn("flex w-fit items-stretch", !compact && "sm:ml-auto")}>
      <Input
        ref={field.fieldRef}
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={field.draft}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-invalid={field.invalid || undefined}
        aria-describedby={[describedBy, unit && unitId, rangeId, field.invalid && numberErrorId(id)]
          .filter(Boolean)
          .join(" ")}
        onChange={(event) => field.change(event.target.value)}
        onBlur={field.commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            field.commit()
          }
        }}
        className={cn("w-24", SETTING_CONTROL_HEIGHT, unit && "rounded-r-none")}
      />
      {unit && (
        <FieldAddon side="end" id={unitId}>
          {unit}
        </FieldAddon>
      )}
      <span id={rangeId} className="sr-only">
        {max === undefined ? `${min} or more.` : `From ${min} to ${max}.`}
      </span>
    </div>
  )
}

/** Why {@link NumberInput} `id`'s draft wasn't saved. */
export function NumberFieldError({ id, min, max }: { id: string; min: number; max?: number }) {
  return (
    <SettingFieldError id={numberErrorId(id)}>
      {max === undefined ? `Enter a whole number of ${min} or more.` : `Enter a whole number from ${min} to ${max}.`}
    </SettingFieldError>
  )
}

type NumberFieldProps = Omit<NumberInputProps, "field" | "max"> & {
  value: number
  max: number
  onCommit: (value: number) => void
  /** The value being typed, for a live preview, while it's valid; `null` once it's committed or invalid. */
  onDraftChange?: (draft: number | null) => void
}

/**
 * A bounded whole number saved like typed text (`useCommittedInteger`): on
 * blur or Enter, so each keystroke doesn't write the preference; Escape
 * reverts it; closing the window without a blur still saves it. Input outside
 * the range stays in the field unsaved, with the error under it.
 */
export function NumberField({ value, onCommit, onDraftChange, ...input }: NumberFieldProps) {
  const field = useCommittedInteger({
    saved: value,
    initial: value,
    min: input.min,
    max: input.max,
    onCommit,
    onDraftChange,
  })
  return (
    <div className="grid gap-1 sm:justify-items-end">
      <NumberInput {...input} field={field} />
      {field.invalid && <NumberFieldError id={input.id} min={input.min} max={input.max} />}
    </div>
  )
}

type NumberSettingFieldProps = Omit<NumberFieldProps, "id" | "aria-label" | "aria-labelledby" | "aria-describedby">

export function NumberSetting({
  setting,
  children,
  ...field
}: NumberSettingFieldProps & {
  setting: AnySettingId
  /** The row body under the field, such as a preview of the value. */
  children?: ReactNode
}) {
  const ids = settingIds(setting)
  const describedBy = useSettingDescribedBy(setting)
  return (
    <SettingRow setting={setting} control={<NumberField {...field} id={ids.control} aria-describedby={describedBy} />}>
      {children}
    </SettingRow>
  )
}

/** The value of `FoldSetting`'s "Taller than" choice. */
export const FOLD_AT_HEIGHT = "at"

export type FoldChoice = "never" | "always" | typeof FOLD_AT_HEIGHT

const FOLD_CHOICE_LABELS: Record<FoldChoice, string> = { never: "Never", always: "Always", at: "Taller than" }

/**
 * Whether tall content starts collapsed, as one segmented choice: Never,
 * Always where collapsing to nothing means something (code, quotes), or
 * "Taller than" (`FOLD_AT_HEIGHT`) the height in `atSetting`, a row of its own
 * under it, then `children`, more rows that refine it. The chosen option says
 * what it does to every `noun`. The height applies only under "Taller than",
 * and says so while another is chosen; editing it changes nothing else until a
 * valid height commits, which `onCommit` saves together with "Taller than".
 */
export function FoldSetting({
  setting,
  atSetting,
  noun,
  always = false,
  choice,
  onChoiceChange,
  children,
  ...height
}: NumberSettingFieldProps & {
  setting: AnySettingId
  atSetting: AnySettingId
  /** What collapses, singular and plural: "code block", "code blocks". */
  noun: { one: string; many: string }
  /** Offer "Always". */
  always?: boolean
  choice: FoldChoice
  onChoiceChange: (choice: FoldChoice) => void
  /** Rows under the height that refine the fold, such as how much a collapsed one shows. */
  children?: ReactNode
}) {
  const descriptions: Record<FoldChoice, string> = {
    never: `Every ${noun.one} opens in full.`,
    always: `Every ${noun.one} starts collapsed.`,
    at: `${upperFirst(noun.many)} over the limit below start collapsed.`,
  }
  const choices: FoldChoice[] = always ? ["never", "always", FOLD_AT_HEIGHT] : ["never", FOLD_AT_HEIGHT]
  const inEffect = choice === FOLD_AT_HEIGHT
  const atIds = settingIds(atSetting)
  const atDescribedBy = useSettingDescribedBy(atSetting, { extra: [!inEffect && atIds.notice] })
  return (
    <>
      <ChoiceSetting<FoldChoice>
        setting={setting}
        variant="segmented"
        value={choice}
        options={choices.map((value) => ({ value, label: FOLD_CHOICE_LABELS[value] }))}
        description={descriptions[choice]}
        onValueChange={onChoiceChange}
      />
      <SettingDependents parent={setting}>
        <SettingRow
          setting={atSetting}
          notice={inEffect ? undefined : `Applies when “${FOLD_CHOICE_LABELS.at}” is chosen.`}
          control={
            <div className={cn(!inEffect && "opacity-60 focus-within:opacity-100")}>
              <NumberField {...height} id={atIds.control} aria-describedby={atDescribedBy} />
            </div>
          }
        />
        {children}
      </SettingDependents>
    </>
  )
}

type SettingsDisclosureProps = {
  /** The current state in a few words, such as "2 types overridden". */
  summary: ReactNode
  children: ReactNode
  /** Open on first render; a link landing inside opens it either way. */
  defaultOpen?: boolean
  /** Why it can't be opened right now: it stays shut, with this as its reason line. */
  inactive?: ReactNode
} & (
  | {
      /** One setting whose detail is tucked away: the disclosure is that setting's row. */
      setting: AnySettingId
      /** In place of the setting's label, such as a call to open it. */
      label?: string
      /** Copy that depends on state, replacing the registry description. */
      description?: ReactNode
      /** Anchors of rows rendered inside, such as each shortcut, that open it too. */
      contains?: readonly string[]
    }
  | {
      /** A group of settings rows, behind a label of its own. */
      label: string
      settings: readonly AnySettingId[]
    }
)

/**
 * The one disclosure trigger in settings, laid out as a link row: heading, the
 * summary as its value in the control column, and a chevron that turns down → up.
 * Use inside a `Collapsible` whose frame is rounded, such as a settings card or
 * a card of its own. With `inactive` it shows why it can't open as the reason
 * line and stays focusable, `aria-disabled`.
 */
export const SettingsDisclosureTrigger = forwardRef<
  HTMLButtonElement,
  { heading: ReactNode; summary?: ReactNode; inactive?: ReactNode; className?: string }
>(function SettingsDisclosureTrigger({ heading, summary, inactive, className }, ref) {
  return (
    <CollapsibleTrigger
      ref={ref}
      aria-disabled={inactive ? true : undefined}
      className={cn(
        "group flex min-h-11 w-full items-center gap-3 rounded-[inherit] px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent data-[state=open]:rounded-b-none motion-reduce:transition-none",
        className
      )}
    >
      <SettingValueRowBody
        text={
          <span className="block space-y-1">
            <span className="flex flex-wrap items-center gap-2">{heading}</span>
            {inactive && <DisabledReason>{inactive}</DisabledReason>}
          </span>
        }
        value={summary}
        chevron={
          <ChevronDown
            aria-hidden
            className={cn(
              SETTING_ROW_CHEVRON_CLASS,
              "transition-transform group-aria-disabled:opacity-50 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            )}
          />
        }
      />
    </CollapsibleTrigger>
  )
})

/**
 * Advanced detail inside a section, closed until asked for. A `?setting=` link
 * naming the disclosed setting, or a row inside it, opens it so search and deep
 * links still land.
 */
export function SettingsDisclosure(props: SettingsDisclosureProps) {
  const { summary, children, defaultOpen = false, inactive } = props
  const activeSetting = useOptionalSettings()?.activeSetting ?? null
  const targets: readonly string[] = "setting" in props ? [props.setting, ...(props.contains ?? [])] : props.settings
  const targeted = activeSetting !== null && targets.includes(activeSetting)
  const [open, setOpen] = useState(targeted || defaultOpen)
  useEffect(() => {
    if (targeted) setOpen(true)
  }, [targeted, activeSetting])

  const def = "setting" in props ? settingDef(props.setting) : null
  const ids = "setting" in props ? settingIds(props.setting) : null
  const label = props.label ?? def?.label
  const description = "setting" in props ? (props.description ?? def?.description) : undefined

  return (
    <Collapsible
      open={open && !inactive}
      onOpenChange={inactive ? undefined : setOpen}
      id={ids?.row}
      data-setting={"setting" in props ? props.setting : undefined}
      {...(ids ? landingTargetProps : {})}
      className={cn("first:rounded-t-lg last:rounded-b-lg", ids && LANDING_TARGET_CLASS)}
    >
      <SettingsDisclosureTrigger
        heading={
          <>
            <span id={ids?.label} className="text-sm font-medium leading-snug">
              {label}
            </span>
            {"setting" in props && <SettingMarks setting={props.setting} />}
          </>
        }
        summary={summary}
        inactive={inactive}
      />
      <CollapsibleContent className={cn(def ? "space-y-3 px-4 pb-4" : "divide-y divide-border border-t")}>
        {description && (
          <p id={ids?.description} className={SETTING_MUTED_NOTE_TEXT}>
            {description}
          </p>
        )}
        {"setting" in props && <SettingTwinLink setting={props.setting} />}
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Saving / saved / failed beside a field, in a fixed slot so nothing shifts. */
export function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <span role="status" className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
      {state.kind === "saving" && (
        <>
          <Loader2 aria-hidden className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
          <span className="sr-only">Saving</span>
        </>
      )}
      {state.kind === "saved" && (
        <>
          <Check aria-hidden className="h-4 w-4 text-muted-foreground" />
          <span className="sr-only">Saved</span>
        </>
      )}
      {state.kind === "error" && <TriangleAlert aria-hidden className="h-4 w-4 text-destructive" />}
    </span>
  )
}

/** The failure text for {@link SaveIndicator}, as the settings field error; renders nothing otherwise. */
export function SaveError({ state, id }: { state: SaveState; id?: string }) {
  if (state.kind !== "error") return null
  return <SettingFieldError id={id}>{state.message}</SettingFieldError>
}
