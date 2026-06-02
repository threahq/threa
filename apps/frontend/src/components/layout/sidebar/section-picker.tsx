import { useState } from "react"
import { Check, FolderPlus, Plus } from "lucide-react"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useSidebarConfig } from "@/hooks/use-sidebar-config"
import { MAX_CUSTOM_SECTION_NAME_LENGTH } from "@threa/types"
import {
  createCustomSection,
  customSections,
  getStreamCustomSectionId,
  newCustomSectionId,
  setStreamCustomSection,
} from "./sidebar-config"

interface SectionPickerProps {
  workspaceId: string
  streamId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * File a single stream into a custom sidebar section — the picker behind the
 * "Add to section…" action (a dialog on desktop, a bottom drawer on mobile, via
 * ResponsiveDialog). Membership is exclusive: picking a section moves the stream
 * there and out of any other; picking the section it's already in removes it.
 * A stream filed here shows only in that section, trumping its smart/label
 * placement. New sections can be created inline and the stream filed into the
 * fresh one in a single step.
 */
export function SectionPicker({ workspaceId, streamId, open, onOpenChange }: SectionPickerProps) {
  const { config, setConfig } = useSidebarConfig(workspaceId)
  const sections = customSections(config)
  const currentId = getStreamCustomSectionId(config, streamId)
  const [newName, setNewName] = useState("")

  const choose = (sectionId: string) => {
    setConfig(setStreamCustomSection(config, streamId, currentId === sectionId ? null : sectionId))
  }

  const createAndFile = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    const id = newCustomSectionId()
    setConfig(setStreamCustomSection(createCustomSection(config, id, trimmed), streamId, id))
    setNewName("")
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} disableSnapPoints>
      <ResponsiveDialogContent
        desktopClassName="sm:max-w-sm gap-0 p-0"
        drawerClassName="flex max-h-[80dvh] flex-col gap-0 pb-[env(safe-area-inset-bottom)]"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-3 text-left">
          <ResponsiveDialogTitle className="text-base">Add to section</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            File this stream into one of your custom sidebar sections.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {sections.length > 0 && (
            <div className="max-h-[min(50vh,320px)] min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
              {sections.map((section) => {
                const selected = section.sectionId === currentId
                return (
                  <button
                    key={section.sectionId}
                    type="button"
                    onClick={() => choose(section.sectionId)}
                    aria-pressed={selected}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm transition-colors",
                      "hover:bg-muted/50 active:bg-muted"
                    )}
                  >
                    <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{section.name}</span>
                    {selected && <Check className="h-4 w-4 shrink-0 text-primary" aria-label="Current section" />}
                  </button>
                )
              })}
            </div>
          )}

          <div className={cn("flex items-center gap-2 px-4 py-3", sections.length > 0 && "border-t")}>
            <input
              type="text"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  createAndFile()
                }
              }}
              maxLength={MAX_CUSTOM_SECTION_NAME_LENGTH}
              placeholder="New section name…"
              aria-label="New section name"
              // text-base keeps the font ≥16px so iOS doesn't zoom on focus.
              className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            />
            <Button type="button" size="sm" variant="outline" onClick={createAndFile} disabled={!newName.trim()}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add
            </Button>
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
