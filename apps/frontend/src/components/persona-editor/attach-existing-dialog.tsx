import { useEffect, useMemo, useState } from "react"
import { Search } from "lucide-react"
import { toast } from "sonner"
import {
  categoryFromMime,
  isPersonaAttachmentMimeAllowed,
  PERSONA_ATTACHMENT_ALLOWED_MIME_TYPES,
  type AttachmentCategory,
} from "@threa/types"
import type { AttachmentSearchItem } from "@/api/attachments"
import { ExplorerList, useAttachmentSearch, type ExplorerFilters } from "@/components/attachment-explorer"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"
import { useAttachPersonaAttachmentFromExisting } from "@/hooks/use-personas"

/**
 * Attachment categories that can cover a persona-eligible file, derived from the
 * mime allowlist so it can't drift: the exact allowed types map to pdf/doc/sheet/
 * code, and every `text/*` subtype fans out to doc (plain), code (markdown/yaml/…)
 * or sheet (csv/tsv). This narrows the server search; it CANNOT express the
 * allowlist exactly (the categories also admit e.g. `.doc`/`.xls`/`.xml`, which
 * are not on the persona allowlist), so the results are additionally filtered
 * client-side by {@link isPersonaAttachmentMimeAllowed}, and the server re-checks
 * eligibility on the actual pick. The narrowing also UNDER-includes: the backend
 * matches categories on exact mime strings, so an uncommon `text/*` subtype the
 * allowlist would accept (e.g. `text/x-log`) never surfaces here — a completeness
 * gap, never a wrong attach. Dropping the category filter would fix it at the
 * cost of noisier results.
 */
const PERSONA_ELIGIBLE_CATEGORIES: AttachmentCategory[] = Array.from(
  new Set<AttachmentCategory>([...PERSONA_ATTACHMENT_ALLOWED_MIME_TYPES.map(categoryFromMime), "doc", "code", "sheet"])
)

const QUERY_DEBOUNCE_MS = 200

interface AttachExistingDialogProps {
  workspaceId: string
  personaId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Search-and-pick dialog that attaches an existing workspace file to a persona's
 * Knowledge by copy (knowledge-by-reference). Reuses the explorer's list/row
 * rendering via `ExplorerList` + its `onSelectAttachment` prop (INV-35/37) rather
 * than forking it; server search already scopes to message-bound CLEAN files the
 * caller can read, so the results are correct for free. A pick fires the copy
 * mutation and closes on success (single-pick v1); the new Knowledge row is the
 * signal (INV-63 — no success toast). A server-side eligibility rejection surfaces
 * its structured message via `toast.error` (INV-11) and leaves the dialog open.
 */
export function AttachExistingDialog({ workspaceId, personaId, open, onOpenChange }: AttachExistingDialogProps) {
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const attach = useAttachPersonaAttachmentFromExisting(workspaceId, personaId)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  // Reset the search each time the dialog opens so a fresh pick starts clean.
  useEffect(() => {
    if (!open) {
      setQuery("")
      setDebouncedQuery("")
    }
  }, [open])

  const filters: ExplorerFilters = useMemo(
    () => ({
      streamIds: [],
      queryText: debouncedQuery,
      categories: PERSONA_ELIGIBLE_CATEGORIES,
      uploadedBy: null,
      nameSubstring: null,
      before: null,
      after: null,
      view: "list",
      selectedAttachmentId: null,
    }),
    [debouncedQuery]
  )

  const search = useAttachmentSearch(workspaceId, filters, { enabled: open })
  const items = useMemo(
    () => search.items.filter((item) => isPersonaAttachmentMimeAllowed(item.mimeType)),
    [search.items]
  )

  const handlePick = (item: AttachmentSearchItem) => {
    if (attach.isPending) return
    attach.mutate(item.id, {
      onSuccess: () => onOpenChange(false),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Couldn't attach that file"),
    })
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="overflow-hidden p-0 gap-0 shadow-lg sm:!fixed sm:!top-[12%] sm:!translate-y-0 sm:!flex sm:!flex-col sm:max-w-[560px] sm:rounded-2xl sm:!h-[70vh]"
        drawerClassName="overflow-hidden p-0 h-[85dvh]"
        hideCloseButton
      >
        <div className="flex h-full flex-col" data-testid="attach-existing-dialog">
          <ResponsiveDialogTitle className="border-b px-4 py-3 text-sm font-semibold">
            Attach existing file
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Search files you can read and attach one to this persona’s knowledge.
          </ResponsiveDialogDescription>
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files by name or content"
              className="h-8 border-none px-1 shadow-none focus-visible:ring-0"
              aria-label="Search files"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Own empty copy: the explorer's inherited strings ("No files yet…",
                "widen the search") describe a surface this dialog is not — the
                picker's scope (files posted in chats you can read, knowledge
                types only) must be stated or an empty result reads as broken. */}
            {!search.isLoading && !search.isError && items.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                {debouncedQuery.trim().length > 0 ? (
                  <>
                    <p className="font-medium text-foreground">No files match &ldquo;{debouncedQuery.trim()}&rdquo;</p>
                    <p className="mt-1">Try a different name or keyword.</p>
                  </>
                ) : (
                  <>
                    <p className="font-medium text-foreground">Search files from your chats</p>
                    <p className="mt-1">
                      This finds text, PDF, Word, Excel, and JSON files already shared in streams you can read. To add
                      something from your device, use Add file instead.
                    </p>
                  </>
                )}
              </div>
            ) : (
              <ExplorerList
                workspaceId={workspaceId}
                items={items}
                isLoading={search.isLoading}
                isError={search.isError}
                hasNextPage={search.hasNextPage}
                isFetchingNextPage={search.isFetchingNextPage}
                fetchNextPage={search.fetchNextPage}
                selectedId={null}
                onSelect={() => undefined}
                onSelectAttachment={handlePick}
                hasFilters={debouncedQuery.trim().length > 0}
                onClearFilters={() => setQuery("")}
              />
            )}
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
