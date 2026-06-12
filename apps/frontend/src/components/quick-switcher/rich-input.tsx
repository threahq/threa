import { useRef, useEffect, useLayoutEffect, useCallback, useImperativeHandle, forwardRef, useMemo } from "react"
import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import { useChannelSuggestion } from "@/components/editor/triggers"
import { useSearchMentionSuggestion } from "@/components/editor/triggers/use-search-mention-suggestion"
import { useFilterTypeSuggestion } from "@/components/editor/triggers/use-filter-type-suggestion"
import { useDateFilterSuggestion } from "@/components/editor/triggers/use-date-filter-suggestion"
import { useFromFilterSuggestion } from "@/components/editor/triggers/use-from-filter-suggestion"
import { useWithFilterSuggestion } from "@/components/editor/triggers/use-with-filter-suggestion"
import { useInUserFilterSuggestion } from "@/components/editor/triggers/use-in-user-filter-suggestion"
import { useInChannelFilterSuggestion } from "@/components/editor/triggers/use-in-channel-filter-suggestion"
import { useStatusFilterSuggestion } from "@/components/editor/triggers/use-status-filter-suggestion"
import { FilterTypeExtension } from "@/components/editor/triggers/filter-type-extension"
import { DateFilterExtension } from "@/components/editor/triggers/date-filter-extension"
import { FromFilterExtension } from "@/components/editor/triggers/from-filter-extension"
import { WithFilterExtension } from "@/components/editor/triggers/with-filter-extension"
import { InUserFilterExtension } from "@/components/editor/triggers/in-user-filter-extension"
import { InChannelFilterExtension } from "@/components/editor/triggers/in-channel-filter-extension"
import { StatusFilterExtension } from "@/components/editor/triggers/status-filter-extension"
import { SearchMentionExtension } from "@/components/editor/triggers/search-mention-extension"
import { SearchChannelExtension } from "@/components/editor/triggers/search-channel-extension"
import { cn, escapeHtml } from "@/lib/utils"

/**
 * Available trigger types for RichInput.
 */
export type TriggerType =
  | "mention" // @user - inserts "@slug "
  | "channel" // #channel - inserts "#slug "
  | "filterType" // type: - inserts "type:value "
  | "dateFilter" // after:/before: - inserts date filter
  | "fromFilter" // from:@ - inserts "from:@slug "
  | "withFilter" // with:@ - inserts "with:@slug "
  | "inUserFilter" // in:@ - inserts "in:@slug " (DM filter)
  | "inChannelFilter" // in:# - inserts "in:#slug " (channel filter)
  | "statusFilter" // status: - inserts "status:value "

/**
 * Preset trigger configurations for common use cases.
 */
export const SEARCH_TRIGGERS: TriggerType[] = [
  "mention",
  "channel",
  "filterType",
  "dateFilter",
  "fromFilter",
  "withFilter",
  "inUserFilter",
  "inChannelFilter",
  "statusFilter",
]

export const COMMAND_TRIGGERS: TriggerType[] = []

export const STREAM_TRIGGERS: TriggerType[] = ["statusFilter", "filterType"]

export interface RichInputProps {
  value: string
  onChange: (value: string) => void
  /** Called when Enter is pressed and no suggestion popover is open.
   *  withModifier is true if Cmd/Ctrl was held (for "open in new tab" behavior).
   */
  onSubmit?: (withModifier: boolean) => void
  onPopoverActiveChange?: (active: boolean) => void
  /** Which triggers to enable. Empty or undefined means no triggers (plain input). */
  triggers?: TriggerType[]
  placeholder?: string
  /** Accessible label for the input (used by screen readers and testing) */
  ariaLabel?: string
  className?: string
  /**
   * Extra classes merged onto the editable element itself — use to override
   * the default `h-11 py-3` sizing (e.g. `h-8 py-1.5` for compact inputs).
   */
  editorClassName?: string
  autoFocus?: boolean
  disabled?: boolean
}

export interface RichInputRef {
  focus: () => void
  blur: () => void
  /** Imperatively close all open suggestion popovers */
  closePopovers: () => void
}

/** @deprecated Use RichInput instead */
export type SearchEditorProps = RichInputProps
/** @deprecated Use RichInputRef instead */
export type SearchEditorRef = RichInputRef

/**
 * TipTap-based input with optional autocomplete triggers.
 * Styled to look like a plain input.
 *
 * When triggers are enabled, supports:
 * - @ for user/persona mentions (search terms)
 * - # for channel references (search terms)
 * - type: for stream type filters
 * - after:/before: for date filters
 *
 * All triggers insert plain text - no styled nodes.
 */
export const RichInput = forwardRef<RichInputRef, RichInputProps>(function RichInput(
  {
    value,
    onChange,
    onSubmit,
    onPopoverActiveChange,
    triggers = [],
    placeholder = "Type here...",
    ariaLabel = "Text input",
    className,
    editorClassName,
    autoFocus = false,
    disabled = false,
  },
  ref
) {
  const isInternalUpdate = useRef(false)
  const isPopoverActiveRef = useRef(false)

  // Helper to check if a trigger is enabled
  const hasTrigger = useCallback((type: TriggerType) => triggers.includes(type), [triggers])

  // Trigger suggestions - always call hooks (React rules), but only use when enabled
  const {
    suggestionConfig: mentionConfig,
    renderMentionList,
    isActive: mentionActive,
    close: closeMention,
  } = useSearchMentionSuggestion()
  const {
    suggestionConfig: channelConfig,
    renderChannelList,
    isActive: channelActive,
    close: closeChannel,
  } = useChannelSuggestion()
  const {
    suggestionConfig: filterTypeConfig,
    renderFilterTypeList,
    isActive: filterTypeActive,
    close: closeFilterType,
  } = useFilterTypeSuggestion()
  const {
    suggestionConfig: dateFilterConfig,
    renderDateFilterList,
    isActive: dateFilterActive,
    close: closeDateFilter,
  } = useDateFilterSuggestion()
  const {
    suggestionConfig: fromFilterConfig,
    renderFromFilterList,
    isActive: fromFilterActive,
    close: closeFromFilter,
  } = useFromFilterSuggestion()
  const {
    suggestionConfig: withFilterConfig,
    renderWithFilterList,
    isActive: withFilterActive,
    close: closeWithFilter,
  } = useWithFilterSuggestion()
  const {
    suggestionConfig: inUserFilterConfig,
    renderInUserFilterList,
    isActive: inUserFilterActive,
    close: closeInUserFilter,
  } = useInUserFilterSuggestion()
  const {
    suggestionConfig: inChannelFilterConfig,
    renderInChannelFilterList,
    isActive: inChannelFilterActive,
    close: closeInChannelFilter,
  } = useInChannelFilterSuggestion()
  const {
    suggestionConfig: statusFilterConfig,
    renderStatusFilterList,
    isActive: statusFilterActive,
    close: closeStatusFilter,
  } = useStatusFilterSuggestion()

  // Track combined popover active state (only for enabled triggers)
  const isPopoverActive =
    (hasTrigger("mention") && mentionActive) ||
    (hasTrigger("channel") && channelActive) ||
    (hasTrigger("filterType") && filterTypeActive) ||
    (hasTrigger("dateFilter") && dateFilterActive) ||
    (hasTrigger("fromFilter") && fromFilterActive) ||
    (hasTrigger("withFilter") && withFilterActive) ||
    (hasTrigger("inUserFilter") && inUserFilterActive) ||
    (hasTrigger("inChannelFilter") && inChannelFilterActive) ||
    (hasTrigger("statusFilter") && statusFilterActive)
  isPopoverActiveRef.current = isPopoverActive

  // Notify parent when popover state changes
  // IMPORTANT: Use useLayoutEffect (not useEffect) to notify SYNCHRONOUSLY
  // before the browser handles any keyboard events. With useEffect, there's a
  // race condition where keyboard events fire before the parent knows the popover is open.
  useLayoutEffect(() => {
    onPopoverActiveChange?.(isPopoverActive)
  }, [isPopoverActive, onPopoverActiveChange])

  // Build extensions array - always include all trigger extensions
  // TipTap's useEditor doesn't recreate when extensions change, so we load all upfront.
  // Extensions are lightweight - they only activate when their trigger pattern is typed.
  // We control visibility via hasTrigger() for popover state and rendering.
  const extensions = useMemo(
    () => [
      // StarterKit with most features disabled - just basic text editing
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
        dropcursor: false,
        gapcursor: false,
        hardBreak: false, // Prevent Shift+Enter from creating hard breaks
        paragraph: {
          HTMLAttributes: {
            class: "m-0 p-0",
          },
        },
      }),
      Placeholder.configure({
        placeholder,
        emptyEditorClass: "is-editor-empty",
      }),
      // All trigger extensions - always loaded, visibility controlled by hasTrigger()
      SearchMentionExtension.configure({ suggestion: mentionConfig }),
      SearchChannelExtension.configure({ suggestion: channelConfig }),
      FilterTypeExtension.configure({ suggestion: filterTypeConfig }),
      DateFilterExtension.configure({ suggestion: dateFilterConfig }),
      FromFilterExtension.configure({ suggestion: fromFilterConfig }),
      WithFilterExtension.configure({ suggestion: withFilterConfig }),
      InUserFilterExtension.configure({ suggestion: inUserFilterConfig }),
      InChannelFilterExtension.configure({ suggestion: inChannelFilterConfig }),
      StatusFilterExtension.configure({ suggestion: statusFilterConfig }),
    ],
    // Note: We intentionally exclude suggestion configs from deps - they're stable refs
    // and including them causes unnecessary editor recreation
    [placeholder]
  )

  const editor = useEditor({
    extensions,
    content: value ? `<p>${escapeHtml(value)}</p>` : "",
    editable: !disabled,
    onUpdate: ({ editor }) => {
      if (isInternalUpdate.current) return
      const text = editor.getText()
      onChange(text)
    },
    editorProps: {
      attributes: {
        class: cn(
          "flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none",
          "placeholder:text-muted-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
          editorClassName
        ),
        "aria-label": ariaLabel,
      },
      handleKeyDown: (_view, event) => {
        // Enter to submit (unless a suggestion popover is open)
        // Check ref because this callback captures stale closure
        if (event.key === "Enter" && !event.shiftKey && !isPopoverActiveRef.current) {
          if (onSubmit) {
            event.preventDefault()
            const withModifier = event.metaKey || event.ctrlKey
            onSubmit(withModifier)
            return true
          }
          // No onSubmit handler - let event bubble to parent for handling
          return false
        }
        return false
      },
    },
  })

  // Sync external value changes
  useEffect(() => {
    if (!editor || editor.isDestroyed) return

    const currentText = editor.getText()
    if (value !== currentText) {
      isInternalUpdate.current = true
      editor.commands.setContent(value ? `<p>${escapeHtml(value)}</p>` : "")
      isInternalUpdate.current = false
    }
  }, [value, editor])

  // Auto-focus on mount
  useEffect(() => {
    if (autoFocus && editor && !editor.isDestroyed) {
      editor.commands.focus("end")
    }
  }, [autoFocus, editor])

  // Expose focus/blur methods
  const focus = useCallback(() => {
    if (editor && !editor.isDestroyed) {
      editor.commands.focus("end")
    }
  }, [editor])

  const blur = useCallback(() => {
    if (editor && !editor.isDestroyed) {
      editor.view.dom.blur()
    }
  }, [editor])

  // Close all open suggestion popovers - called by parent when Escape is pressed
  // (Radix Dialog intercepts Escape before TipTap can see it)
  const closePopovers = useCallback(() => {
    if (hasTrigger("mention")) closeMention()
    if (hasTrigger("channel")) closeChannel()
    if (hasTrigger("filterType")) closeFilterType()
    if (hasTrigger("dateFilter")) closeDateFilter()
    if (hasTrigger("fromFilter")) closeFromFilter()
    if (hasTrigger("withFilter")) closeWithFilter()
    if (hasTrigger("inUserFilter")) closeInUserFilter()
    if (hasTrigger("inChannelFilter")) closeInChannelFilter()
    if (hasTrigger("statusFilter")) closeStatusFilter()
  }, [
    hasTrigger,
    closeMention,
    closeChannel,
    closeFilterType,
    closeDateFilter,
    closeFromFilter,
    closeWithFilter,
    closeInUserFilter,
    closeInChannelFilter,
    closeStatusFilter,
  ])

  useImperativeHandle(ref, () => ({ focus, blur, closePopovers }), [focus, blur, closePopovers])

  return (
    <div className={cn("relative flex-1", className)}>
      <EditorContent editor={editor} />
      {hasTrigger("mention") && renderMentionList()}
      {hasTrigger("channel") && renderChannelList()}
      {hasTrigger("filterType") && renderFilterTypeList()}
      {hasTrigger("dateFilter") && renderDateFilterList()}
      {hasTrigger("fromFilter") && renderFromFilterList()}
      {hasTrigger("withFilter") && renderWithFilterList()}
      {hasTrigger("inUserFilter") && renderInUserFilterList()}
      {hasTrigger("inChannelFilter") && renderInChannelFilterList()}
      {hasTrigger("statusFilter") && renderStatusFilterList()}
    </div>
  )
})

/** @deprecated Use RichInput instead */
export const SearchEditor = RichInput
