import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useUpdateCompanionMode } from "@/hooks/use-streams"
import { CompanionModes, type CompanionMode, type Stream } from "@threa/types"
import { toast } from "sonner"

interface CompanionTabProps {
  workspaceId: string
  stream: Stream
}

export function CompanionTab({ workspaceId, stream }: CompanionTabProps) {
  const { mutateAsync: updateCompanionMode, isPending } = useUpdateCompanionMode(workspaceId, stream.id)

  // E2E streams force companion off server-side (INV-E1); reflect that constraint in the UI.
  const isE2e = stream.e2eEnabled === true

  const handleChange = async (next: string) => {
    if (next !== CompanionModes.ON && next !== CompanionModes.OFF) return
    if (next === stream.companionMode) return
    try {
      await updateCompanionMode(next as CompanionMode)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update companion mode"
      toast.error(message)
    }
  }

  return (
    <div className="space-y-6 p-1">
      <div className="space-y-3">
        <Label className="text-sm font-medium">Companion mode</Label>
        <RadioGroup value={stream.companionMode} onValueChange={handleChange} disabled={isPending || isE2e}>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value={CompanionModes.ON} id="companion-on" />
            <Label htmlFor="companion-on" className="font-normal">
              On — the companion responds to new messages
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value={CompanionModes.OFF} id="companion-off" />
            <Label htmlFor="companion-off" className="font-normal">
              Off — messages are stored without any AI response
            </Label>
          </div>
        </RadioGroup>
      </div>

      {isE2e && (
        <p className="text-sm text-muted-foreground">
          End-to-end encrypted streams can&apos;t use the companion — responses would be plaintext.
        </p>
      )}
    </div>
  )
}
