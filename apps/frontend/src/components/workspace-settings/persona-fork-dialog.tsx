import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { PERSONA_NAME_MAX_CHARS, type PersonaListItem } from "@threahq/types"
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
import { SettingAddButton } from "@/components/settings/setting-primitives"

interface PersonaForkDialogProps {
  workspaceId: string
  /** Fork sources: every persona currently visible to the caller (built-ins +
   *  active customs, plus the caller's own personal personas for a personal fork).
   *  Only what the dialog renders is required, so store rows qualify without a
   *  fabricated full PersonaListItem. */
  sources: Pick<PersonaListItem, "id" | "name">[]
  /**
   * Fork target scope. `workspace` (default, admin surface) creates a shared
   * custom agent; `personal` creates one private to the caller. Only one line of
   * copy and the request scope differ — one dialog serves both.
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
        onError: () => toast.error("Couldn't create the agent"),
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <SettingAddButton>New agent</SettingAddButton>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Copy another agent&apos;s prompt, tools, model and style, or start blank.{" "}
            {isPersonal ? "Only you can use it." : "Everyone in the workspace can use it."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="fork-source">Copy from</Label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger id="fork-source" className="h-11 sm:h-9 [@media(pointer:coarse)]:min-h-11">
                <SelectValue placeholder="Pick an agent" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((source) => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.name}
                  </SelectItem>
                ))}
                <SelectItem value={BLANK_SOURCE}>Blank agent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fork-name">Name</Label>
            <Input
              id="fork-name"
              value={name}
              maxLength={PERSONA_NAME_MAX_CHARS}
              placeholder="e.g. Researcher"
              className="h-11 sm:h-9 [@media(pointer:coarse)]:min-h-11"
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
            <Button type="button" variant="ghost" size="sm" className="h-11 sm:h-9 [@media(pointer:coarse)]:min-h-11">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            size="sm"
            className="h-11 sm:h-9 [@media(pointer:coarse)]:min-h-11"
            onClick={handleCreate}
            disabled={!canCreate}
          >
            {fork.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
