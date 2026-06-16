import { useState, useEffect, useRef } from "react"

const PRELOAD_TIMEOUT_MS = 2000
const MAX_CONCURRENT = 6

/**
 * Preload image URLs into the browser cache; returns true once all are loaded
 * or the timeout expires. Loads at most MAX_CONCURRENT in parallel to avoid
 * saturating browser connections.
 */
export function usePreloadImages(urls: string[]): boolean {
  const [ready, setReady] = useState(urls.length === 0)
  const resolvedRef = useRef(false)
  const urlKeyRef = useRef("")

  const urlKey = urls.join(",")

  useEffect(() => {
    if (urls.length === 0) {
      setReady(true)
      return
    }

    if (urlKey === urlKeyRef.current) return
    urlKeyRef.current = urlKey

    // Once resolved on initial load, don't block again; preload new URLs in the
    // background.
    if (resolvedRef.current) {
      urls.forEach((url) => {
        const img = new Image()
        img.src = url
      })
      return
    }

    let cancelled = false
    let loaded = 0
    const total = urls.length
    let nextIndex = 0

    const resolve = () => {
      if (!resolvedRef.current && !cancelled) {
        resolvedRef.current = true
        setReady(true)
      }
    }

    const loadNext = () => {
      if (nextIndex >= total) return
      const url = urls[nextIndex++]
      const img = new Image()
      img.onload = img.onerror = () => {
        loaded++
        if (loaded >= total) {
          resolve()
        } else {
          loadNext()
        }
      }
      img.src = url
    }

    const initialBatch = Math.min(MAX_CONCURRENT, total)
    for (let i = 0; i < initialBatch; i++) {
      loadNext()
    }

    const timer = setTimeout(resolve, PRELOAD_TIMEOUT_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [urlKey, urls])

  return ready
}
