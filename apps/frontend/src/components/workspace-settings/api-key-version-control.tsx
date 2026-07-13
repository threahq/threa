import { API_VERSIONS, CURRENT_API_VERSION } from "@threa/types"
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
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:text-foreground"
      >
        <span>API version:</span>
        <span className="font-medium text-foreground/80">{label}</span>
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuLabel className="text-xs">Pin this key to an API version</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={apiVersion ?? LATEST_VALUE}
          onValueChange={(value) => onChange(value === LATEST_VALUE ? null : value)}
        >
          <DropdownMenuRadioItem value={LATEST_VALUE} className="text-xs">
            Always latest ({CURRENT_API_VERSION})
          </DropdownMenuRadioItem>
          {API_VERSIONS.map((version) => (
            <DropdownMenuRadioItem key={version} value={version} className="text-xs font-mono">
              {version}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
