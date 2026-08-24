import { Maximize2, PanelRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AsideSurface } from "@/stores/aside-store"

type ReadingSurface = Exclude<AsideSurface, "minimized">

const SURFACES: { value: ReadingSurface; label: string; icon: typeof PanelRight }[] = [
  { value: "dock", label: "Dock aside", icon: PanelRight },
  { value: "fullscreen", label: "Aside fullscreen", icon: Maximize2 },
]

interface AsideSurfacePickerProps {
  value: ReadingSurface
  onChange: (surface: ReadingSurface) => void
  /** Dock is refused while a call owns the right edge. */
  dockDisabled?: boolean
}

/**
 * Where the aside is being read, as one segmented control rather than a row of
 * loose toggles — the shape a call's surface control has, in the place a call
 * puts it. Minimize and close stay separate: they leave the surface, they are
 * not another way of showing it.
 */
export function AsideSurfacePicker({ value, onChange, dockDisabled = false }: AsideSurfacePickerProps) {
  return (
    <div role="group" aria-label="Aside surface" className="flex items-center gap-0.5 rounded-md border p-0.5">
      {SURFACES.map(({ value: surface, label, icon: Icon }) => {
        const active = value === surface
        return (
          <Tooltip key={surface}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={label}
                aria-pressed={active}
                disabled={surface === "dock" && dockDisabled}
                onClick={() => onChange(surface)}
                className={cn("h-6 w-6 rounded-[5px]", active && "bg-accent text-primary")}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {label}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
