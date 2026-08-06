import { Link } from "react-router-dom"
import { ChevronDown } from "lucide-react"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { type ActionDefinition, type GroupedAction, resolveActionLabel } from "./action-model"

/**
 * The body of a row context menu: grouped actions rendered as dropdown items.
 * Shared by the timeline's `MessageContextMenu` and the drafts explorer's
 * `DraftContextMenu` so both surfaces present the same wording, ordering and
 * split-button behavior over their own context types.
 */
export function ActionDropdownItems<Context>({
  items,
  context,
  onClose,
}: {
  items: GroupedAction<Context>[]
  context: Context
  onClose: () => void
}) {
  return (
    <>
      {items.map((item) => (
        <GroupedItem
          key={item.kind === "single" ? item.action.id : item.members[0].id}
          item={item}
          context={context}
          onClose={onClose}
        />
      ))}
    </>
  )
}

function GroupedItem<Context>({
  item,
  context,
  onClose,
}: {
  item: GroupedAction<Context>
  context: Context
  onClose: () => void
}) {
  if (item.kind === "single") {
    return <SingleAction action={item.action} context={context} onClose={onClose} showSeparatorBefore />
  }

  // Split-button group: render the primary as a normal item, then a chevron
  // sub-trigger that opens a sub-menu listing ALL group members (primary
  // first, then the rest). Radix positions the sub-menu next to the trigger
  // (side/align are not configurable on `DropdownMenuSubContent`); we nudge
  // it with `sideOffset` / `alignOffset` for visual breathing room. Same
  // data model as the mobile drawer (driven by `groupVisibleActions`).
  const { members } = item
  const primary = members[0]
  const PrimaryIcon = primary.icon
  const isDestructive = primary.variant === "destructive"
  const primaryDisabled = primary.disabled?.(context) ?? false

  return (
    <>
      {primary.separatorBefore && <DropdownMenuSeparator />}
      <div className="flex items-stretch group/split">
        <DropdownMenuItem
          className={cn(
            "flex-1 gap-2 cursor-pointer rounded-r-none",
            isDestructive && "text-destructive focus:text-destructive"
          )}
          disabled={primaryDisabled}
          onSelect={() => {
            onClose()
            primary.action?.(context)
          }}
        >
          <PrimaryIcon className={cn("h-4 w-4", isDestructive ? "" : "text-muted-foreground")} />
          {resolveActionLabel(primary, context)}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className="px-2 cursor-pointer rounded-l-none border-l border-border/50 [&>svg.lucide-chevron-right]:hidden"
            aria-label={`Other ${primary.groupId ?? "options"}`}
          >
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent sideOffset={4} alignOffset={-4}>
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
                  {resolveActionLabel(member, context)}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </div>
    </>
  )
}

function SingleAction<Context>({
  action,
  context,
  onClose,
  showSeparatorBefore,
}: {
  action: ActionDefinition<Context>
  context: Context
  onClose: () => void
  showSeparatorBefore?: boolean
}) {
  const Icon = action.icon
  const href = action.getHref?.(context)
  const separator = showSeparatorBefore && action.separatorBefore ? <DropdownMenuSeparator /> : null

  if (href) {
    return (
      <>
        {separator}
        <DropdownMenuItem asChild className="gap-2 cursor-pointer">
          <Link to={href} onClick={onClose}>
            <Icon className="h-4 w-4 text-muted-foreground" />
            {resolveActionLabel(action, context)}
          </Link>
        </DropdownMenuItem>
      </>
    )
  }

  const isDestructive = action.variant === "destructive"

  return (
    <>
      {separator}
      <DropdownMenuItem
        className={
          isDestructive ? "gap-2 cursor-pointer text-destructive focus:text-destructive" : "gap-2 cursor-pointer"
        }
        disabled={action.disabled?.(context) ?? false}
        onSelect={() => {
          onClose()
          action.action?.(context)
        }}
      >
        <Icon className={isDestructive ? "h-4 w-4" : "h-4 w-4 text-muted-foreground"} />
        {resolveActionLabel(action, context)}
      </DropdownMenuItem>
    </>
  )
}
