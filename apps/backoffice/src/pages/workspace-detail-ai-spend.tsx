import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useParams } from "react-router-dom"
import { Section } from "@/components/layout/section"
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
      {query.isLoading ? (
        <p className="border-t pt-5 text-sm text-muted-foreground">Loading AI spend controls…</p>
      ) : null}
      {query.error ? <InlineBanner tone="error">Couldn't load AI spend controls.</InlineBanner> : null}
      {controls ? (
        <div className="flex flex-col gap-5 border-t pt-5">
          {error ? <InlineBanner tone="error">Couldn't save AI spend controls: {error}</InlineBanner> : null}
          <label className="flex min-h-10 items-center gap-3 text-sm">
            <input
              type="checkbox"
              role="switch"
              className="size-5 accent-destructive"
              checked={mutation.isPending ? mutation.variables.operatorAiDisabled : controls.operatorAiDisabled}
              disabled={mutation.isPending}
              onChange={(e) => mutation.mutate({ ...controls, operatorAiDisabled: e.target.checked })}
            />
            AI off for this workspace
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
      className="flex flex-col gap-3 sm:max-w-xs"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSave(nextUsd)
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ai-operator-ceiling">Monthly ceiling (USD)</Label>
        <Input
          id="ai-operator-ceiling"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={ceiling}
          onChange={(e) => setCeiling(e.target.value)}
          aria-invalid={!valid}
        />
      </div>
      <div>
        <Button type="submit" disabled={!valid || nextUsd === ceilingUsd || saving}>
          {saving ? "Saving…" : "Save ceiling"}
        </Button>
      </div>
    </form>
  )
}
