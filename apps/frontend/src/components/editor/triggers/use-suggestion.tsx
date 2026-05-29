import { useState, useCallback, useMemo, useRef, type RefObject, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import type { SuggestionListRef } from "./suggestion-list"

interface SuggestionState<T> {
  items: T[]
  query: string
  clientRect: (() => DOMRect | null) | null
  command: ((item: T) => void) | null
}

export interface UseSuggestionConfig<T> {
  /** TipTap extension name — used to sync popupVisible in editor.storage */
  extensionName: string
  /**
   * Get all available items for synchronous, client-side filtering (called via
   * ref to avoid stale closures). Required unless `searchItems` is provided.
   */
  getItems?: () => T[]
  /**
   * Filter items by query string. Required unless `searchItems` is provided.
   * Receives the editor so filters can gate on cursor context (e.g. the slash
   * palette hides whole-message commands unless the `/` opens the message).
   */
  filterItems?: (items: T[], query: string, editor?: Editor) => T[]
  /**
   * Async item source (e.g. server-backed search). When provided, it replaces
   * the `getItems` + `filterItems` path entirely; the returned promise is handed
   * straight to TipTap's suggestion plugin, which awaits it before rendering.
   */
  searchItems?: (query: string) => Promise<T[]>
  /** Render the suggestion list component */
  renderList: (props: {
    ref: RefObject<SuggestionListRef | null>
    items: T[]
    query: string
    clientRect: (() => DOMRect | null) | null
    command: (item: T) => void
  }) => ReactNode
}

export interface UseSuggestionResult<T> {
  /** Configuration to pass to the TipTap extension */
  suggestionConfig: {
    items: (props: { query: string }) => T[] | Promise<T[]>
    render: () => {
      onStart: (props: SuggestionProps<T>) => void
      onUpdate: (props: SuggestionProps<T>) => void
      onExit: (props: SuggestionProps<T>) => void
      onKeyDown: (props: SuggestionKeyDownProps) => boolean
    }
  }
  /** Call this in your component to render the suggestion popup */
  renderSuggestionList: () => ReactNode
  /** Whether the suggestion popup is currently active */
  isActive: boolean
  /** Imperatively close the suggestion popup */
  close: () => void
}

/**
 * Generic hook for managing TipTap suggestion state.
 * Handles the lifecycle callbacks and portal rendering.
 */
export function useSuggestion<T>(config: UseSuggestionConfig<T>): UseSuggestionResult<T> {
  const { extensionName, getItems, filterItems, searchItems, renderList } = config
  const [state, setState] = useState<SuggestionState<T> | null>(null)
  const listRef = useRef<SuggestionListRef>(null)
  const editorRef = useRef<Editor | null>(null)
  // Tracks the most recently requested async query. TipTap's suggestion plugin
  // awaits `items()` but does NOT serialize those awaits, so a slower earlier
  // fetch can resolve after a newer one and overwrite fresh results with stale
  // (often empty) ones — the empty-state flicker. We drop any `onUpdate` whose
  // query isn't the latest. Only armed for async sources; sync filtering can't
  // race so its behavior is unchanged.
  const latestQueryRef = useRef<string | null>(null)

  // Use refs to avoid stale closures in the TipTap callback (captured once at
  // extension creation time).
  const getItemsRef = useRef(getItems)
  getItemsRef.current = getItems
  const filterItemsRef = useRef(filterItems)
  filterItemsRef.current = filterItems
  const searchItemsRef = useRef(searchItems)
  searchItemsRef.current = searchItems

  const setPopupVisible = useCallback(
    (editor: Editor, visible: boolean) => {
      const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>)[extensionName]
      if (storage) storage.popupVisible = visible
    },
    [extensionName]
  )

  // Stable callback that reads from refs - TipTap captures this at extension
  // creation time. Async search (when configured) takes precedence over the
  // sync getItems + filterItems path; the promise is returned as-is so the
  // suggestion plugin can await it.
  const getSuggestionItems = useCallback(
    ({ query, editor }: { query: string; editor?: Editor }): T[] | Promise<T[]> => {
      const search = searchItemsRef.current
      if (search) {
        latestQueryRef.current = query
        return search(query)
      }
      const items = getItemsRef.current?.() ?? []
      const filter = filterItemsRef.current
      return filter ? filter(items, query, editor) : items
    },
    []
  )

  const onStart = useCallback(
    (props: SuggestionProps<T>) => {
      editorRef.current = props.editor
      setPopupVisible(props.editor, props.items.length > 0)
      setState({
        items: props.items,
        query: props.query,
        clientRect: props.clientRect ?? null,
        command: props.command,
      })
    },
    [setPopupVisible]
  )

  const onUpdate = useCallback(
    (props: SuggestionProps<T>) => {
      // Drop out-of-order async resolutions: only the latest requested query's
      // results may update the popup (see latestQueryRef).
      if (searchItemsRef.current && props.query !== latestQueryRef.current) return
      setPopupVisible(props.editor, props.items.length > 0)
      setState({
        items: props.items,
        query: props.query,
        clientRect: props.clientRect ?? null,
        command: props.command,
      })
    },
    [setPopupVisible]
  )

  const onExit = useCallback(
    (props: SuggestionProps<T>) => {
      setPopupVisible(props.editor, false)
      setState(null)
    },
    [setPopupVisible]
  )

  // Imperative close for when Radix intercepts Escape before TipTap
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

  const renderSuggestionList = useCallback(() => {
    if (!state || !state.command) return null

    return createPortal(
      renderList({
        ref: listRef,
        items: state.items,
        query: state.query,
        clientRect: state.clientRect,
        command: state.command,
      }),
      document.body
    )
  }, [state, renderList])

  return {
    suggestionConfig,
    renderSuggestionList,
    isActive: state !== null,
    close,
  }
}
