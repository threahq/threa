import { useCallback, useSyncExternalStore } from "react"
import type { Editor } from "@tiptap/core"
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { Check, ChevronDown, Code } from "lucide-react"
import { CODE_LANGUAGES_BY_LABEL, formatCodeLanguage, normalizeCodeLanguage } from "@threahq/types"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { cn } from "@/lib/utils"

type CodeLanguageOption = (typeof CODE_LANGUAGES_BY_LABEL)[number]

const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium leading-none text-muted-foreground"

/** `setEditable` emits `update` without a transaction, so a node view has to listen for it. */
function useEditorEditable(editor: Editor): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      editor.on("update", onChange)
      return () => {
        editor.off("update", onChange)
      }
    },
    [editor]
  )
  return useSyncExternalStore(subscribe, () => editor.isEditable)
}

/**
 * A code block with its language as a chip in the corner. The chip opens a
 * searchable list; the pick is the node's `language` attr, so it is the fence
 * info string on the wire and syncs like any attr in a shared document.
 */
export function CodeBlockView({ node, editor, getPos, updateAttributes }: NodeViewProps) {
  const languageId = normalizeCodeLanguage(node.attrs.language as string | null)
  const label = formatCodeLanguage(languageId)
  const editable = useEditorEditable(editor)
  const selected = CODE_LANGUAGES_BY_LABEL.find((language) => language.id === languageId) ?? null

  const returnFocusToCode = (event: Event) => {
    event.preventDefault()
    const pos = getPos()
    if (pos === undefined) return
    const { from } = editor.state.selection
    const caretInBlock = from > pos && from < pos + node.nodeSize
    editor.commands.focus(caretInBlock ? null : pos + node.nodeSize - 1)
  }

  const chipContent = (
    <>
      <Code className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </>
  )

  return (
    <NodeViewWrapper data-language={languageId}>
      <pre>
        <span contentEditable={false} className="-ml-1 -mt-1 mb-1.5 flex select-none">
          {editable ? (
            <SearchableSelect<CodeLanguageOption>
              items={CODE_LANGUAGES_BY_LABEL}
              value={selected}
              onChange={(language) => updateAttributes({ language: language.id })}
              getKey={(language) => language.id}
              getKeywords={(language) => [language.label, language.id, ...language.aliases]}
              renderItem={(language, isSelected) => (
                <>
                  <Check className={cn("mr-2 h-4 w-4", isSelected ? "opacity-100" : "opacity-0")} />
                  {language.label}
                </>
              )}
              searchPlaceholder="Search languages"
              emptyMessage="No language found."
              contentClassName="min-w-56"
              onCloseAutoFocus={returnFocusToCode}
              trigger={
                <button
                  type="button"
                  aria-label={`Code language: ${label}`}
                  className={cn(
                    CHIP_CLASS,
                    "relative hover:bg-background/70 hover:text-foreground",
                    // Widens the hit area to a thumb-sized target without moving the chip.
                    "after:absolute after:-inset-x-1.5 after:-inset-y-2"
                  )}
                >
                  {chipContent}
                  <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                </button>
              }
            />
          ) : (
            <span className={CHIP_CLASS}>{chipContent}</span>
          )}
        </span>
        <NodeViewContent<"code"> as="code" className="shiki" />
      </pre>
    </NodeViewWrapper>
  )
}
