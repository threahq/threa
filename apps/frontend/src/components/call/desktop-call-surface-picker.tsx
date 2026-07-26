import type { RefObject } from "react"
import { Maximize, PanelRight, PictureInPicture2, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DesktopSurface } from "@/stores/call-prefs-store"

const OPTIONS: { value: DesktopSurface; label: string; icon: LucideIcon }[] = [
  { value: "floating", label: "Floating", icon: PictureInPicture2 },
  { value: "sidebar", label: "Sidebar", icon: PanelRight },
  { value: "fullscreen", label: "Fullscreen", icon: Maximize },
]

export function DesktopCallSurfacePicker({
  value,
  onValueChange,
  triggerRef,
}: {
  value: DesktopSurface
  onValueChange: (value: DesktopSurface) => void
  triggerRef?: RefObject<HTMLButtonElement | null>
}) {
  const selected = OPTIONS.find((option) => option.value === value) ?? OPTIONS[0]
  const SelectedIcon = selected.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={`Change call view. Current: ${selected.label}`}
          title="Change call view"
        >
          <SelectedIcon className="h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onPointerDown={(event) => event.stopPropagation()}>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onValueChange(next as DesktopSurface)}>
          {OPTIONS.map((option) => {
            const Icon = option.icon
            return (
              <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2">
                <Icon className="h-4 w-4" aria-hidden />
                {option.label}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
