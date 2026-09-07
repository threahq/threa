import { useEffect, useRef } from "react"
import { toast } from "@/lib/sonner-module"
import { Toaster } from "@/components/ui/sonner"
import { useAppUpdate } from "@/hooks/use-app-update"

const TOAST_ID = "app-update"

type NoticeState = "ready" | "applying" | "failed"

/** What the live notice reads as, and the build it is about. */
type LiveNotice = { state: NoticeState; buildId: string } | null

/** Sonner's published options plus the `type` reset its public shape omits. */
type NoticeOptions = NonNullable<Parameters<typeof toast>[1]> & { type?: undefined }

// True only in the Playwright E2E build (vite `define`, gated on
// VITE_BACKEND_PORT), where this `duration: Infinity` notice would park over the
// composer and intercept pointer events for the rest of the run. typeof-guarded
// because the `define` isn't applied under vitest. Never gated in production —
// this notice is the only signal a new build is parked.
declare const __E2E_BUILD__: boolean

/**
 * Announces a downloaded, locally ready build and reflects the shared apply
 * operation the App status page drives too.
 *
 * Mount through `AppToastHost`, never on its own: everything this raises is lost
 * unless a `<Toaster>` subscribed first. Whether the user dismissed a build
 * lives in the controller, so the announcement survives this component's
 * remounts without re-announcing what was waved off.
 */
export function AppUpdateNotifier() {
  const { phase, failure, readyBuildId, dismissedBuildId, apply, dismissNotice } = useAppUpdate()
  const liveNoticeRef = useRef<LiveNotice>(null)
  const applyRef = useRef(apply)
  applyRef.current = apply
  const dismissNoticeRef = useRef(dismissNotice)
  dismissNoticeRef.current = dismissNotice

  useEffect(() => {
    if (typeof __E2E_BUILD__ === "boolean" && __E2E_BUILD__) return

    const runApply = (event: { preventDefault: () => void }) => {
      // Keep the toast up: it becomes the progress surface for the same apply
      // the App status page would run, and the page may never be open.
      event.preventDefault()
      void applyRef.current()
    }

    // Sonner merges an update into the live toast rather than replacing it, so
    // anything a previous state set survives unless this one overwrites it: the
    // error type would tint a recovered notice red, `dismissible: false` from an
    // apply would trap it, and the failure description would sit under a ready
    // title. `type` is absent from the published options because each helper
    // sets its own, so clearing it needs the key present.
    const announce = (state: NoticeState, buildId: string, present: (options: NoticeOptions) => void) => {
      const notice: LiveNotice = { state, buildId }
      const options: NoticeOptions = {
        id: TOAST_ID,
        type: undefined,
        description: undefined,
        action: undefined,
        dismissible: true,
        duration: Infinity,
        // Sonner fires `onDismiss` for a programmatic `toast.dismiss()` too, and
        // fires it a frame late — by then this notice may already have been
        // withdrawn or replaced. Identity, not build equality: a withdrawal
        // followed by the same build returning must not read as the user waving
        // that build off.
        onDismiss: () => {
          if (liveNoticeRef.current !== notice) return
          liveNoticeRef.current = null
          dismissNoticeRef.current(buildId)
        },
      }
      liveNoticeRef.current = notice
      present(options)
    }

    // `readyBuildId`, not the phase, says a reload has somewhere to land: a
    // background check moves the phase off `ready` while the same build stays
    // parked, and withdrawing the notice there would strand the user on the old
    // build with no way back to it.
    if (readyBuildId === null || readyBuildId === dismissedBuildId) {
      if (liveNoticeRef.current === null) return
      // Drop the live notice before withdrawing it: the `onDismiss` this
      // triggers is ours, and must not be recorded as the user's.
      liveNoticeRef.current = null
      toast.dismiss(TOAST_ID)
      return
    }

    // A notice this mount never opened still gets to open now — the toast host
    // remounts on workspace transitions, and going silent under a running apply
    // would leave the reload it started with no feedback anywhere.
    const live = liveNoticeRef.current?.buildId === readyBuildId ? liveNoticeRef.current.state : null

    if (phase === "applying") {
      if (live === "applying") return
      announce("applying", readyBuildId, (options) =>
        toast.loading("Updating Threa…", { ...options, dismissible: false })
      )
      return
    }

    if (phase === "failed" && (failure === "activation-failed" || failure === "activation-timeout")) {
      if (live === "failed") return
      announce("failed", readyBuildId, (options) =>
        toast.error("Threa couldn't finish updating", {
          ...options,
          description: "The build you have keeps running.",
          action: { label: "Try again", onClick: runApply },
        })
      )
      return
    }

    if (live === "ready") return
    announce("ready", readyBuildId, (options) =>
      toast("A new version of Threa is ready", { ...options, action: { label: "Reload", onClick: runApply } })
    )
  }, [phase, failure, readyBuildId, dismissedBuildId])

  return null
}

/**
 * The app's toast outlet and the update notifier, as one mount.
 *
 * Sonner's `<Toaster>` starts empty and only renders what is raised after its
 * own subscribe effect runs — there is no replay. A notifier mounted anywhere
 * else announced a parked build into nothing and, having recorded it as
 * announced, never offered it again. Adjacency inside one component is what
 * keeps that from coming back.
 */
export function AppToastHost() {
  return (
    <>
      <Toaster />
      <AppUpdateNotifier />
    </>
  )
}
