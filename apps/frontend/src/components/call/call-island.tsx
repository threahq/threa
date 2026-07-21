import { Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useCallLaunch } from "./call-launch-context"
import { PreJoinGate } from "./pre-join-gate"

/**
 * The dark "island" surface — the mobile call chrome, pairing with the iOS
 * Dynamic Island. Deliberately dark in BOTH themes (like the OS island) so it
 * never fights light mode. Shared class so the connected drawer's collapsed
 * modes and the joining surface read as one shape (INV-35).
 */
export const ISLAND_SURFACE = "bg-call-stage text-white shadow-lg ring-1 ring-white/10"

/** Top-centered, non-interactive wrapper; the child re-enables pointer events. */
const ISLAND_WRAP = "pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center"

/**
 * The mobile joining surface. Renders in the SAME top position as the connected
 * island so joining → connected is one surface morphing in place — no desktop
 * dock at the bottom, no bottom→top jump, no orphan spinner box (the plan's
 * call-open fix). A slim spinner pill while connecting; the permission / join-
 * error taxonomy drops into a top card (the shared {@link PreJoinGate}), still
 * top-anchored, reachable, and cancelable.
 */
export function MobileCallJoining() {
  const { state, cancel } = useCallLaunch()
  const isError = state.status === "permission_error" || state.status === "join_error"

  return (
    <div className={ISLAND_WRAP} style={{ paddingTop: "env(safe-area-inset-top)" }}>
      {isError ? (
        <div
          className={cn("pointer-events-auto mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl px-4", ISLAND_SURFACE)}
        >
          <PreJoinGate onDark />
        </div>
      ) : (
        <div
          className={cn(
            "pointer-events-auto mt-1.5 flex items-center gap-2.5 rounded-full py-2 pl-4 pr-2",
            ISLAND_SURFACE
          )}
          role="status"
        >
          <Loader2 className="h-4 w-4 animate-spin text-white/75" aria-hidden />
          <span className="text-sm font-medium">Joining…</span>
          <button
            type="button"
            aria-label="Cancel joining"
            onClick={cancel}
            className="flex h-9 w-9 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}
