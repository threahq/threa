import { API_VERSIONS, CURRENT_API_VERSION } from "@threahq/types"
import { ChevronDown } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { cn } from "@/lib/utils"

// Sentinel for the "unpinned / track latest" choice — a radio group needs a
// string value and null is the wire representation for it.
const LATEST_VALUE = "__latest__"

interface ApiKeyVersionControlProps {
  /** Pinned version date, or null when the key tracks the current version. */
  apiVersion: string | null
  onChange: (apiVersion: string | null) => void
  disabled?: boolean
}

export function ApiKeyVersionControl({ apiVersion, onChange, disabled }: ApiKeyVersionControlProps) {
  const label = apiVersion ?? `Latest (${CURRENT_API_VERSION})`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          "inline-flex min-h-11 items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none sm:min-h-0 [@media(pointer:coarse)]:min-h-11",
          SETTING_NOTE_TEXT
        )}
      >
        <span>API version:</span>
        <span className="text-foreground">{label}</span>
        <ChevronDown aria-hidden className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Pin this key to an API version
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={apiVersion ?? LATEST_VALUE}
          onValueChange={(value) => onChange(value === LATEST_VALUE ? null : value)}
        >
          <DropdownMenuRadioItem value={LATEST_VALUE}>Always latest ({CURRENT_API_VERSION})</DropdownMenuRadioItem>
          {API_VERSIONS.map((version) => (
            <DropdownMenuRadioItem key={version} value={version} className="font-mono">
              {version}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
