import { toast } from "sonner"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useUpdateToolPolicy } from "@/hooks/use-streams"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "@threa/types"

// `messaging` is intentionally absent: the agent's own reply tool is always
// allowed, so it is never offered as a toggle. These are the gateable groups.
const CATEGORY_OPTIONS: { value: ToolPrivacyCategory; label: string; description: string }[] = [
  { value: "web", label: "Web", description: "Web search and fetching public URLs." },
  { value: "workspace", label: "Workspace", description: "Search this workspace's messages, streams, and memos." },
  { value: "github", label: "GitHub", description: "Read from connected GitHub." },
  { value: "linear", label: "Linear", description: "Read from connected Linear." },
]

const ALL_GATEABLE = CATEGORY_OPTIONS.map((option) => option.value)

// Inside the enclave Ariadne only builds web tools, so on an encrypted
// scratchpad the other categories exist as toggles but aren't wired yet.
const ENCLAVE_TOOL_CATEGORIES = new Set<ToolPrivacyCategory>(["web"])
const NOT_IN_ENCLAVE_REASON =
  "Not yet available in encrypted scratchpads — inside the enclave Ariadne only has web tools today."

interface ToolPolicyPickerProps {
  workspaceId: string
  streamId: string
  /** Current policy: `null` = unrestricted; an array (incl. `[]`) = restricted to those categories. */
  value: ToolPrivacyPolicy
  /**
   * Categories the workspace actually has configured (so unconnected GitHub /
   * Linear never show). Undefined (older cached bootstrap) falls back to all.
   */
  configuredCategories?: ToolPrivacyCategory[]
  /** Encrypted scratchpad: non-web categories render disabled, with a reason. */
  e2e: boolean
}

export function ToolPolicyPicker({ workspaceId, streamId, value, configuredCategories, e2e }: ToolPolicyPickerProps) {
  const { mutateAsync, isPending } = useUpdateToolPolicy(workspaceId, streamId)

  // The cache (via `value`) is the source of truth — no local state, so a
  // success re-renders from the patched bootstrap and an error leaves the prior
  // value untouched.
  const restricted = value !== null
  const allowed = new Set(value ?? [])
  const shown = configuredCategories ?? ALL_GATEABLE
  const options = CATEGORY_OPTIONS.filter((option) => shown.includes(option.value))

  const apply = async (next: ToolPrivacyPolicy) => {
    try {
      await mutateAsync(next)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update tool access")
    }
  }

  const handleRestrictToggle = (on: boolean) => apply(on ? [] : null)

  const handleCategoryToggle = (category: ToolPrivacyCategory) => {
    const next = new Set(allowed)
    if (next.has(category)) next.delete(category)
    else next.add(category)
    apply([...next])
  }

  return (
    <div className="space-y-3 border-t pt-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="text-sm font-medium">Restrict tool access</Label>
          <p className="text-xs text-muted-foreground">
            By default Ariadne can use every tool she has. Restrict her to only the tool groups you choose. She can
            always reply.
          </p>
        </div>
        <Switch
          checked={restricted}
          onCheckedChange={handleRestrictToggle}
          disabled={isPending}
          aria-label="Restrict tool access"
        />
      </div>

      {restricted && (
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((option) => (
            <ToolCategoryRow
              key={option.value}
              label={option.label}
              description={option.description}
              checked={allowed.has(option.value)}
              notImplementedReason={e2e && !ENCLAVE_TOOL_CATEGORIES.has(option.value) ? NOT_IN_ENCLAVE_REASON : null}
              disabled={isPending}
              onToggle={() => handleCategoryToggle(option.value)}
            />
          ))}
        </div>
      )}

      {restricted && allowed.size === 0 && (
        <p className="text-xs text-muted-foreground">
          No tool groups selected — Ariadne can only read this scratchpad and reply.
        </p>
      )}
    </div>
  )
}

interface ToolCategoryRowProps {
  label: string
  description: string
  checked: boolean
  /** When set, the category isn't wired in this runtime: render disabled with this hover reason. */
  notImplementedReason: string | null
  disabled: boolean
  onToggle: () => void
}

function ToolCategoryRow({
  label,
  description,
  checked,
  notImplementedReason,
  disabled,
  onToggle,
}: ToolCategoryRowProps) {
  const notImplemented = notImplementedReason !== null
  const row = (
    <label
      className={cn("flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm", notImplemented && "opacity-60")}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} disabled={disabled || notImplemented} />
      <span>
        <span className="flex items-center gap-1.5 font-medium">
          {label}
          {notImplemented && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Soon</span>}
        </span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  )

  if (!notImplemented) return row

  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent>{notImplementedReason}</TooltipContent>
    </Tooltip>
  )
}
