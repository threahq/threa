import { useSyncExternalStore } from "react"
import type { FloatingSurfaceGeometry, Rect } from "@/components/call/call-surface-geometry"

// Layout channel: the desktop floating call surface publishes its viewport
// geometry — its own rect plus the measured rects of its interactive groups —
// here so the sibling incoming-ring overlay (mounted elsewhere in the tree) can
// step out of its way. Module-level state survives the account-switch remount, so
// AccountScope clears it explicitly (INV-9) rather than relying on the surface's
// own unmount cleanup landing first — otherwise the next account's ring avoids a
// square that is no longer on screen.

let geometry: FloatingSurfaceGeometry | null = null
const listeners = new Set<() => void>()

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function sameGeometry(a: FloatingSurfaceGeometry | null, b: FloatingSurfaceGeometry | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (!sameRect(a.rect, b.rect)) return false
  if (a.protectedRects.length !== b.protectedRects.length) return false
  return a.protectedRects.every((region, i) => {
    const other = b.protectedRects[i]
    return !!other && sameRect(region, other)
  })
}

export function publishFloatingSurfaceGeometry(next: FloatingSurfaceGeometry | null): void {
  if (sameGeometry(geometry, next)) return
  geometry = next
  for (const listener of listeners) listener()
}

export function getFloatingSurfaceGeometry(): FloatingSurfaceGeometry | null {
  return geometry
}

export function resetFloatingSurfaceGeometryStoreCache(): void {
  publishFloatingSurfaceGeometry(null)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useFloatingSurfaceGeometry(): FloatingSurfaceGeometry | null {
  return useSyncExternalStore(subscribe, getFloatingSurfaceGeometry, getFloatingSurfaceGeometry)
}
