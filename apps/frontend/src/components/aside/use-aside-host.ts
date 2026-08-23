import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { dropAsideForHost } from "@/stores/aside-store"

/**
 * Binds the aside surface to the page: the host key is the route pathname, and
 * leaving the page (the key changing, or the page unmounting) drops whatever
 * aside was open on it — so the next stream is clean by construction and the
 * anchor row is the only way back in.
 */
export function useAsideHost(): string {
  const { pathname: hostKey } = useLocation()
  useEffect(() => () => dropAsideForHost(hostKey), [hostKey])
  return hostKey
}
