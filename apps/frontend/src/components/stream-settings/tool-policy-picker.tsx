import { toast } from "sonner"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
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

interface ToolPolicyPickerProps {
  workspaceId: string
  streamId: string
  /** Current policy: `null` = unrestricted; an array (incl. `[]`) = restricted to those categories. */
  value: ToolPrivacyPolicy
}

export function ToolPolicyPicker({ workspaceId, streamId, value }: ToolPolicyPickerProps) {
  const { mutateAsync, isPending } = useUpdateToolPolicy(workspaceId, streamId)

  // The cache (via `value`) is the source of truth — no local state, so a
  // success re-renders from the patched bootstrap and an error leaves the prior
  // value untouched.
  const restricted = value !== null
  const allowed = new Set(value ?? [])

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
          {CATEGORY_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm">
              <Checkbox
                checked={allowed.has(option.value)}
                onCheckedChange={() => handleCategoryToggle(option.value)}
                disabled={isPending}
              />
              <span>
                <span className="block font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              </span>
            </label>
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
