import { Moon, Sun, Monitor, Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePreferences, useSettings } from "@/contexts"
import type { Theme } from "@threa/types"

interface ThemeDropdownProps {
  /**
   * Notified when the menu opens/closes. The sidebar host wires this to
   * `setMenuOpen` so the menu opening (a Radix modal portal that flips
   * `pointer-events` under the cursor, firing a stray `mouseleave` on the
   * sidebar) doesn't collapse the hover-preview sidebar out from under the
   * still-open dropdown — same guard the other sidebar menus use.
   */
  onOpenChange?: (open: boolean) => void
}

export function ThemeDropdown({ onOpenChange }: ThemeDropdownProps) {
  const { preferences, resolvedTheme, updatePreference } = usePreferences()
  const { openSettings } = useSettings()

  const theme = preferences?.theme ?? "system"

  const setTheme = (newTheme: Theme) => {
    updatePreference("theme", newTheme)
  }

  let ThemeIcon = Sun
  if (theme === "system") {
    ThemeIcon = Monitor
  } else if (resolvedTheme === "dark") {
    ThemeIcon = Moon
  }

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Theme & Settings">
          <ThemeIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor className="mr-2 h-4 w-4" />
          System
          {theme === "system" && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="mr-2 h-4 w-4" />
          Light
          {theme === "light" && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="mr-2 h-4 w-4" />
          Dark
          {theme === "dark" && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openSettings("appearance")}>
          <Settings className="mr-2 h-4 w-4" />
          All Settings...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
