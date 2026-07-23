import type { RefObject } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DesktopSurface } from "@/stores/call-prefs-store"

const OPTIONS: { value: DesktopSurface; label: string }[] = [
  { value: "floating", label: "Floating" },
  { value: "sidebar", label: "Sidebar" },
  { value: "fullscreen", label: "Fullscreen" },
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
  const label = OPTIONS.find((option) => option.value === value)?.label ?? "Floating"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2"
          aria-label="Call surface"
        >
          <span className="w-[4.5rem] text-left">{label}</span>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onValueChange(next as DesktopSurface)}>
          {OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
