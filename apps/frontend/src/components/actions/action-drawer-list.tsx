import { Link } from "react-router-dom"
import { ChevronDown } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { type ActionDefinition, type GroupedAction, resolveActionLabel } from "./action-model"

/**
 * The action list inside a long-press bottom sheet — the rows themselves, not
 * the sheet. Shared by the timeline's `MessageActionDrawer` (which wraps it in
 * message chrome: preview, emoji bar, quote-selection view) and the drafts
 * explorer's `DraftActionDrawer`, so both long-press surfaces render the same
 * rows and split-button groups over their own context types.
 */
export function ActionDrawerList<Context>({
  items,
  context,
  onClose,
  onAction,
}: {
  items: GroupedAction<Context>[]
  context: Context
  onClose: () => void
  onAction: (action: ActionDefinition<Context>) => void
}) {
  return (
    <>
      {items.map((item) => (
        <DrawerActionItem
          key={item.kind === "single" ? item.action.id : item.members[0].id}
          item={item}
          context={context}
          onClose={onClose}
          onAction={onAction}
        />
      ))}
    </>
  )
}

function Divider() {
  return <Separator className="mx-3 my-1 bg-border/50" />
}

function DrawerActionItem<Context>({
  item,
  context,
  onClose,
  onAction,
}: {
  item: GroupedAction<Context>
  context: Context
  onClose: () => void
  onAction: (action: ActionDefinition<Context>) => void
}) {
  if (item.kind === "single") {
    const action = item.action
    return (
      <>
        {action.separatorBefore && <Divider />}
        <DrawerActionPrimary action={action} context={context} onClose={onClose} onAction={onAction} />
      </>
    )
  }

  const { members } = item
  const primary = members[0]
  return (
    <>
      {primary.separatorBefore && <Divider />}
      <DrawerActionSplitRow members={members} context={context} onClose={onClose} onAction={onAction} />
    </>
  )
}

/** Single-action row body (used both standalone and as the left half of a split row). */
function DrawerActionPrimary<Context>({
  action,
  context,
  onClose,
  onAction,
  className,
}: {
  action: ActionDefinition<Context>
  context: Context
  onClose: () => void
  onAction: (action: ActionDefinition<Context>) => void
  className?: string
}) {
  const Icon = action.icon
  const isDestructive = action.variant === "destructive"
  const href = action.getHref?.(context)
  const disabled = action.disabled?.(context) ?? false

  const baseClassName = cn(
    "flex items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors",
    isDestructive ? "text-destructive active:bg-destructive/10" : "active:bg-muted/80"
  )
  const iconEl = (
    <Icon className={cn("h-[18px] w-[18px] shrink-0", isDestructive ? "text-destructive" : "text-muted-foreground")} />
  )

  if (href) {
    return (
      <Link to={href} className={cn(baseClassName, "rounded-lg w-full", className)} onClick={onClose}>
        {iconEl}
        <span>{resolveActionLabel(action, context)}</span>
      </Link>
    )
  }

  return (
    <button
      type="button"
      className={cn(baseClassName, "w-full rounded-lg disabled:opacity-50 disabled:active:bg-transparent", className)}
      disabled={disabled}
      onClick={() => onAction(action)}
    >
      {iconEl}
      <span>{resolveActionLabel(action, context)}</span>
    </button>
  )
}

/**
 * Split-row pattern (à la GitHub's merge button): the primary action is the
 * default tap target on the left; a chevron button on the right opens a small
 * dropdown listing ALL group members (primary first). Same data model as the
 * desktop context menu — the action list declares the group via `groupId` and
 * `groupVisibleActions` collapses adjacent same-group entries into the
 * `{ members }` shape this row consumes.
 */
function DrawerActionSplitRow<Context>({
  members,
  context,
  onClose,
  onAction,
}: {
  members: ActionDefinition<Context>[]
  context: Context
  onClose: () => void
  onAction: (action: ActionDefinition<Context>) => void
}) {
  const primary = members[0]
  return (
    <div className="flex items-stretch w-full rounded-lg overflow-hidden">
      <div className="flex-1 min-w-0">
        <DrawerActionPrimary
          action={primary}
          context={context}
          onClose={onClose}
          onAction={onAction}
          className="rounded-none rounded-l-lg"
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center justify-center w-10 shrink-0 border-l border-border/50 text-muted-foreground active:bg-muted/80 transition-colors rounded-r-lg"
            aria-label={`Other ${primary.groupId ?? "options"}`}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-[220px]">
          {members.map((member, idx) => {
            const MemberIcon = member.icon
            const isPrimary = idx === 0
            return (
              <DropdownMenuItem
                key={member.id}
                className={cn("gap-2 cursor-pointer", isPrimary && "font-medium")}
                disabled={member.disabled?.(context) ?? false}
                onSelect={() => {
                  onClose()
                  member.action?.(context)
                }}
              >
                <MemberIcon className="h-4 w-4 text-muted-foreground" />
                <span>{resolveActionLabel(member, context)}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
