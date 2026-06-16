import { useState, useCallback, useRef, useMemo, type RefObject, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { EmojiEntry } from "@threa/types"
import {
  DESKTOP_GRID_COLUMNS,
  MAX_RECENTLY_USED_ROWS,
  filterBySearch,
  pickRecentlyUsed,
  sortByDefaultOrder,
} from "@/lib/emoji-picker"
import type { SuggestionListRef } from "./suggestion-list"
import { EmojiGrid } from "./emoji-grid"

interface EmojiSuggestionState {
  recent: EmojiEntry[]
  all: EmojiEntry[]
  clientRect: (() => DOMRect | null) | null
  command: ((item: EmojiEntry) => void) | null
}

export interface UseEmojiSuggestionConfig {
  emojis: EmojiEntry[]
  /** Per-emoji weights driving personalized "recently used" sorting */
  emojiWeights: Record<string, number>
}

export interface UseEmojiSuggestionResult {
  suggestionConfig: {
    items: (props: { query: string }) => EmojiEntry[]
    render: () => {
      onStart: (props: SuggestionProps<EmojiEntry>) => void
      onUpdate: (props: SuggestionProps<EmojiEntry>) => void
      onExit: (props: SuggestionProps<EmojiEntry>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
  renderEmojiGrid: () => ReactNode
  isActive: boolean
  close: () => void
}

/**
 * Hook for managing emoji suggestion state with a two-section layout.
 *
 * The grid is split into:
 * 1. Recently used — weighted emojis (weight > 0), capped at 2 rows.
 * 2. Emojis — all emojis in default order (group → in-group order).
 *
 * Both sections are filtered by the search query; the same emoji can appear
 * in both when it matches.
 */
export function useEmojiSuggestion(config: UseEmojiSuggestionConfig): UseEmojiSuggestionResult {
  const { emojis, emojiWeights } = config
  const [state, setState] = useState<EmojiSuggestionState | null>(null)
  const listRef = useRef<SuggestionListRef>(null)
  const editorRef = useRef<Editor | null>(null)

  const setPopupVisible = useCallback((editor: Editor, visible: boolean) => {
    const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).emoji
    if (storage) storage.popupVisible = visible
  }, [])

  const allSorted = useMemo(() => sortByDefaultOrder(emojis), [emojis])
  const recentBase = useMemo(
    () => pickRecentlyUsed(emojis, emojiWeights, DESKTOP_GRID_COLUMNS * MAX_RECENTLY_USED_ROWS),
    [emojis, emojiWeights]
  )

  // Stable refs so TipTap callbacks (captured at extension creation time) see current data.
  const allSortedRef = useRef(allSorted)
  allSortedRef.current = allSorted
  const recentBaseRef = useRef(recentBase)
  recentBaseRef.current = recentBase

  // TipTap's items(query) drives popupVisible. Return the "all" section filtered
  // by the query so the popup hides only when nothing matches anywhere.
  const getSuggestionItems = useCallback(
    ({ query }: { query: string }) => filterBySearch(allSortedRef.current, query),
    []
  )

  const computeSections = useCallback(
    (query: string, allFiltered: EmojiEntry[]) => ({
      recent: filterBySearch(recentBaseRef.current, query),
      all: allFiltered,
    }),
    []
  )

  const onStart = useCallback(
    (props: SuggestionProps<EmojiEntry>) => {
      editorRef.current = props.editor
      setPopupVisible(props.editor, props.items.length > 0)
      const { recent, all } = computeSections(props.query, props.items)
      setState({
        recent,
        all,
        clientRect: props.clientRect ?? null,
        command: props.command,
      })
    },
    [setPopupVisible, computeSections]
  )

  const onUpdate = useCallback(
    (props: SuggestionProps<EmojiEntry>) => {
      setPopupVisible(props.editor, props.items.length > 0)
      const { recent, all } = computeSections(props.query, props.items)
      setState({
        recent,
        all,
        clientRect: props.clientRect ?? null,
        command: props.command,
      })
    },
    [setPopupVisible, computeSections]
  )

  const onExit = useCallback(
    (props: SuggestionProps<EmojiEntry>) => {
      setPopupVisible(props.editor, false)
      setState(null)
    },
    [setPopupVisible]
  )

  const close = useCallback(() => {
    if (editorRef.current) setPopupVisible(editorRef.current, false)
    setState(null)
  }, [setPopupVisible])

  const onKeyDown = useCallback(
    (props: SuggestionKeyDownProps) => {
      if (props.event.key === "Escape") {
        props.event.preventDefault()
        if (editorRef.current) setPopupVisible(editorRef.current, false)
        setState(null)
        return true
      }
      return listRef.current?.onKeyDown(props.event) ?? false
    },
    [setPopupVisible]
  )

  const suggestionConfig = useMemo(
    () => ({
      items: getSuggestionItems,
      render: () => ({
        onStart,
        onUpdate,
        onExit,
        onKeyDown,
      }),
    }),
    [getSuggestionItems, onStart, onUpdate, onExit, onKeyDown]
  )

  const renderEmojiGrid = useCallback(() => {
    if (!state || !state.command) return null

    return createPortal(
      <EmojiGrid
        ref={listRef as RefObject<SuggestionListRef>}
        recent={state.recent}
        all={state.all}
        clientRect={state.clientRect}
        command={state.command}
      />,
      document.body
    )
  }, [state])

  return {
    suggestionConfig,
    renderEmojiGrid,
    isActive: state !== null,
    close,
  }
}
