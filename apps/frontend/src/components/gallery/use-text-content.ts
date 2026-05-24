import { useEffect, useState } from "react"

// Module-level URL → fetch promise cache so the viewer body and the gallery's
// Copy button issue a single network round-trip per presigned URL. The URLs are
// already attachment-API-deduped (15-min TTL); this caches the text response so
// hitting Copy on an already-loaded panel resolves immediately.
const textCache = new Map<string, Promise<string>>()

export interface TextContentState {
  content: string | null
  error: boolean
}

export function useTextContent(url: string | null): TextContentState {
  const [state, setState] = useState<TextContentState>({ content: null, error: false })

  useEffect(() => {
    if (!url) {
      setState({ content: null, error: false })
      return
    }
    let mounted = true
    setState({ content: null, error: false })

    let promise = textCache.get(url)
    if (!promise) {
      promise = fetch(url).then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        return res.text()
      })
      textCache.set(url, promise)
    }

    promise
      .then((text) => {
        if (mounted) setState({ content: text, error: false })
      })
      .catch(() => {
        if (mounted) setState({ content: null, error: true })
        // Drop the failed promise so a retry on next mount can try again.
        textCache.delete(url)
      })

    return () => {
      mounted = false
    }
  }, [url])

  return state
}

/** Fetch text for a URL using the shared cache, without subscribing a component
 *  to the result. Used for one-shot reads like the gallery Copy button. */
export function fetchTextContent(url: string): Promise<string> {
  let promise = textCache.get(url)
  if (!promise) {
    promise = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`status ${res.status}`)
      return res.text()
    })
    textCache.set(url, promise)
  }
  return promise.catch((err) => {
    textCache.delete(url)
    throw err
  })
}
