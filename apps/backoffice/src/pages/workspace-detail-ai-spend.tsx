import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useParams } from "react-router-dom"
import { Section } from "@/components/layout/section"
import { CARD_CLASS, ListPlaceholder, ROW_PADDING } from "@/components/layout/rows"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { InlineBanner } from "@/components/inline-banner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  backofficeKeys,
  getWorkspaceAISpendControls,
  setWorkspaceAISpendControls,
  type WorkspaceAISpendControls,
} from "@/api/backoffice"
import { readApiError } from "@/api/client"

export function WorkspaceDetailAISpendPage() {
  const { id } = useParams<{ id: string }>()
  if (!id) return null
  return <WorkspaceAISpendSection workspaceId={id} />
}

export function WorkspaceAISpendSection({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: backofficeKeys.workspaceAISpendControls(workspaceId),
    queryFn: () => getWorkspaceAISpendControls(workspaceId),
  })

  const mutation = useMutation({
    mutationFn: (next: WorkspaceAISpendControls) => setWorkspaceAISpendControls(workspaceId, next),
    onSuccess: (saved) => {
      queryClient.setQueryData(backofficeKeys.workspaceAISpendControls(workspaceId), saved)
    },
  })

  const controls = query.data
  const error = readApiError(mutation.error)

  return (
    <Section
      label="AI spend"
      description="The workspace stops at the lower of its own monthly budget and this ceiling. Workspace admins can't change either control."
    >
      {query.isLoading ? <ListPlaceholder>Loading AI spend controls…</ListPlaceholder> : null}
      {query.error ? <InlineBanner tone="error">Couldn't load AI spend controls.</InlineBanner> : null}
      {error ? <InlineBanner tone="error">Couldn't save AI spend controls: {error}</InlineBanner> : null}
      {controls ? (
        <div className={cn(CARD_CLASS, "divide-y")}>
          <label className={cn("flex min-h-14 cursor-pointer items-center justify-between gap-4", ROW_PADDING)}>
            <span className="text-sm font-medium">AI off for this workspace</span>
            <Switch
              checked={mutation.isPending ? mutation.variables.operatorAiDisabled : controls.operatorAiDisabled}
              disabled={mutation.isPending}
              onChange={(e) => mutation.mutate({ ...controls, operatorAiDisabled: e.target.checked })}
            />
          </label>
          {/* Re-keying on the stored ceiling resets the input after a save or refetch. */}
          <CeilingForm
            key={controls.operatorCeilingUsd}
            ceilingUsd={controls.operatorCeilingUsd}
            saving={mutation.isPending}
            onSave={(operatorCeilingUsd) => mutation.mutate({ ...controls, operatorCeilingUsd })}
          />
        </div>
      ) : null}
    </Section>
  )
}

function CeilingForm({
  ceilingUsd,
  saving,
  onSave,
}: {
  ceilingUsd: number
  saving: boolean
  onSave: (ceilingUsd: number) => void
}) {
  const [ceiling, setCeiling] = useState(String(ceilingUsd))
  const nextUsd = Number(ceiling)
  const valid = ceiling.trim() !== "" && Number.isFinite(nextUsd) && nextUsd >= 0

  return (
    <form
      className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6", ROW_PADDING)}
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSave(nextUsd)
      }}
    >
      <Label htmlFor="ai-operator-ceiling" className="text-sm font-medium">
        Monthly ceiling (USD)
      </Label>
      <div className="flex gap-2 sm:w-80">
        <Input
          id="ai-operator-ceiling"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={ceiling}
          onChange={(e) => setCeiling(e.target.value)}
          aria-invalid={!valid}
          className="tabular-nums"
        />
        <Button type="submit" disabled={!valid || nextUsd === ceilingUsd || saving}>
          {saving ? "Saving…" : "Save ceiling"}
        </Button>
      </div>
    </form>
  )
}
