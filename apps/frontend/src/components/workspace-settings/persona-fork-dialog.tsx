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
  /** Fork sources: every persona currently visible to the caller (built-ins +
   *  active customs, plus the caller's own personal personas for a personal fork).
   *  Only what the dialog renders is required, so store rows qualify without a
   *  fabricated full PersonaListItem. */
  sources: Pick<PersonaListItem, "id" | "name">[]
  /**
   * Fork target scope. `workspace` (default, admin surface) creates a shared
   * custom "agent"; `personal` creates a "persona" private to the caller
   * (user-scoped-personas). Only the copy and the request scope differ — one
   * dialog serves both.
   */
  scope?: "workspace" | "personal"
}

/**
 * Fork a source persona (built-in or custom) into a new editable copy, then
 * navigate to its editor. Create = copy-then-edit, or start from a blank agent
 * (starter prompt, default model, no tools). The name seeds a workspace-scoped
 * slug server-side. A `workspace` fork is a shared custom (admin); a `personal`
 * fork is private to the caller.
 */
const BLANK_SOURCE = "blank"
export function PersonaForkDialog({ workspaceId, sources, scope = "workspace" }: PersonaForkDialogProps) {
  const navigate = useNavigate()
  const fork = useForkPersona(workspaceId)
  const [open, setOpen] = useState(false)
  const [sourceId, setSourceId] = useState<string>(sources[0]?.id ?? "")
  const [name, setName] = useState("")
  const isPersonal = scope === "personal"
  const noun = isPersonal ? "persona" : "agent"

  const canCreate = !!sourceId && name.trim().length > 0 && name.length <= PERSONA_NAME_MAX_CHARS && !fork.isPending

  // Reset on any close (Cancel / Escape / overlay), not just the success path, so
  // a dismissed dialog reopens blank instead of carrying a stale name/source.
  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setName("")
      setSourceId(sources[0]?.id ?? "")
    }
  }

  const handleCreate = () => {
    if (!canCreate) return
    fork.mutate(
      { sourcePersonaId: sourceId === BLANK_SOURCE ? null : sourceId, name: name.trim(), scope },
      {
        onSuccess: (persona) => {
          setOpen(false)
          setName("")
          navigate(`/w/${workspaceId}/settings/personas/${persona.id}`)
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : `Failed to create ${noun}`),
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          <Plus className="mr-1 h-3.5 w-3.5" />
          New {noun}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New {noun}</DialogTitle>
          <DialogDescription>
            Fork an existing {noun} into an editable copy — its prompt, tools, model, and style carry over. Or start
            from a blank {noun} and write your own.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="fork-source">Copy from</Label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger id="fork-source">
                <SelectValue placeholder={`Select a ${noun}`} />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.name}
                  </SelectItem>
                ))}
                <SelectItem value={BLANK_SOURCE}>Blank {noun}</SelectItem>
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
