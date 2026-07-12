import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { Plus } from "lucide-react"
import { PERSONA_NAME_MAX_CHARS, type PersonaListItem } from "@threa/types"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useForkPersona } from "@/hooks/use-personas"

interface PersonaForkDialogProps {
  workspaceId: string
  /** Fork sources: every persona currently on the roster (built-ins + active customs). */
  sources: PersonaListItem[]
}

/**
 * "New agent" — fork a source persona (built-in or custom) into a new workspace
 * custom, then navigate to its editor. Create = copy-then-edit (there is no
 * blank-persona path). The name seeds a workspace-scoped slug server-side.
 */
export function PersonaForkDialog({ workspaceId, sources }: PersonaForkDialogProps) {
  const navigate = useNavigate()
  const fork = useForkPersona(workspaceId)
  const [open, setOpen] = useState(false)
  const [sourceId, setSourceId] = useState<string>(sources[0]?.id ?? "")
  const [name, setName] = useState("")

  const canCreate = !!sourceId && name.trim().length > 0 && name.length <= PERSONA_NAME_MAX_CHARS && !fork.isPending

  const handleCreate = () => {
    if (!canCreate) return
    fork.mutate(
      { sourcePersonaId: sourceId, name: name.trim() },
      {
        onSuccess: (persona) => {
          setOpen(false)
          setName("")
          navigate(`/w/${workspaceId}/settings/personas/${persona.id}`)
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to create agent"),
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Plus className="mr-1 h-3.5 w-3.5" />
          New agent
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Fork an existing agent into an editable copy — its prompt, tools, model, and style carry over.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="fork-source">Copy from</Label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger id="fork-source">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fork-name">Name</Label>
            <Input
              id="fork-name"
              value={name}
              maxLength={PERSONA_NAME_MAX_CHARS}
              placeholder="e.g. Research assistant"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  handleCreate()
                }
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" size="sm" onClick={handleCreate} disabled={!canCreate}>
            {fork.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
