import { Download } from "lucide-react"
import type * as Y from "yjs"
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror"
import { serializeToMarkdown } from "@threahq/prosemirror"
import { DOC_FRAGMENT, StreamTypes, type JSONContent } from "@threahq/types"
import { COPY_CONTENT_ENTRIES } from "@/components/actions/action-model"
import type { SidebarActionItem } from "@/components/layout/sidebar/sidebar-actions"
import { downloadBlob } from "@/lib/image-utils"
import { streamFallbackLabel } from "@/lib/streams"

/** The doc as one Markdown file: its title as the heading, then the body as the editor holds it now. */
export function docMarkdown(ydoc: Y.Doc, title: string | null): string {
  const body = serializeToMarkdown(yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(DOC_FRAGMENT)) as JSONContent)
  return [title ? `# ${title}` : "", body].filter(Boolean).join("\n\n")
}

/** A file name every OS accepts: path separators, reserved and control characters out, no leading dot. */
export function docMarkdownFilename(title: string | null): string {
  const name = (title ?? "")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
    .replace(/^[\s.]+/, "")
    .replace(/\s+/g, " ")
    .trim()
  return `${name || streamFallbackLabel(StreamTypes.DOC, "generic")}.md`
}

/** Copy as Markdown, Copy as Plain text and Download as Markdown, each reading the doc when picked. */
export function docExportActions(ydoc: Y.Doc, title: string | null): SidebarActionItem[] {
  return [
    ...COPY_CONTENT_ENTRIES.map(({ copy, ...entry }) => ({ ...entry, onSelect: () => copy(docMarkdown(ydoc, title)) })),
    {
      id: "download-markdown",
      label: "Download as Markdown",
      icon: Download,
      onSelect: () =>
        downloadBlob(
          new Blob([docMarkdown(ydoc, title)], { type: "text/markdown;charset=utf-8" }),
          docMarkdownFilename(title)
        ),
    },
  ]
}
