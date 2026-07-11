import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  WORKSPACE_PERMISSION_SCOPES,
  type ListWorkspacePersonasResponse,
  type WorkspacePersonaSummary,
} from "@threa/types"
import { personasApi } from "@/api"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface AgentsTabProps {
  workspaceId: string
}

/**
 * Workspace configuration for built-in AI personas (roadmap 7.1 subset).
 * Today this is only the model override — a temporary control until the
 * persona editor ships. Editing is admin-gated; others see current values.
 */
export function AgentsTab({ workspaceId }: AgentsTabProps) {
  const queryClient = useQueryClient()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)

  const personasQueryKey = ["personas", workspaceId, "config"]
  const { data, isLoading } = useQuery({
    queryKey: personasQueryKey,
    queryFn: () => personasApi.list(workspaceId),
    refetchOnMount: "always",
  })

  const mutation = useMutation({
    mutationFn: ({ personaId, model }: { personaId: string; model: string | null }) =>
      personasApi.updateConfig(workspaceId, personaId, { model }),
    onSuccess: (persona: WorkspacePersonaSummary) => {
      queryClient.setQueryData<ListWorkspacePersonasResponse>(personasQueryKey, (old) =>
        old ? { ...old, personas: old.personas.map((p) => (p.id === persona.id ? persona : p)) } : old
      )
    },
    onError: () => {
      toast.error("Failed to update the agent model")
    },
  })

  if (isLoading || !data) {
    return <p className="p-1 text-sm text-muted-foreground">Loading agents…</p>
  }

  return (
    <div className="space-y-6 p-1">
      {data.personas.map((persona) => (
        <PersonaSection
          key={persona.id}
          persona={persona}
          availableModels={data.availableModels}
          canManage={canManage}
          saving={mutation.isPending}
          onChangeModel={(model) => mutation.mutate({ personaId: persona.id, model })}
        />
      ))}
    </div>
  )
}

// Sentinel select value for "no workspace override" — sends `model: null` to the API.
const DEFAULT_MODEL_VALUE = "__default__"

interface PersonaSectionProps {
  persona: WorkspacePersonaSummary
  availableModels: ListWorkspacePersonasResponse["availableModels"]
  canManage: boolean
  saving: boolean
  onChangeModel: (model: string | null) => void
}

function PersonaSection({ persona, availableModels, canManage, saving, onChangeModel }: PersonaSectionProps) {
  const isOverridden = persona.overriddenFields.includes("model")
  const selectValue = isOverridden ? persona.model : DEFAULT_MODEL_VALUE
  const modelName = (id: string) => availableModels.find((m) => m.id === id)?.name ?? id

  return (
    <section>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{persona.name}</h3>
        {isOverridden && (
          <Badge variant="secondary" className="text-xs">
            Customized
          </Badge>
        )}
      </div>
      {persona.description && <p className="mt-0.5 text-xs text-muted-foreground">{persona.description}</p>}

      <div className="mt-3">
        <Label htmlFor={`persona-model-${persona.id}`} className="text-sm font-medium">
          Model
        </Label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Which model powers {persona.name} in this workspace. Applies from the next response.
        </p>
        {canManage ? (
          <Select
            value={selectValue}
            disabled={saving}
            onValueChange={(value) => {
              const next = value === DEFAULT_MODEL_VALUE ? null : value
              if ((next === null) === !isOverridden && (next === null || next === persona.model)) return
              onChangeModel(next)
            }}
          >
            <SelectTrigger id={`persona-model-${persona.id}`} className="mt-2 w-full max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL_VALUE}>Default — {modelName(persona.defaultModel)}</SelectItem>
              {availableModels.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {modelName(persona.model)}
            {!isOverridden && " (default)"}
          </p>
        )}
      </div>
    </section>
  )
}
