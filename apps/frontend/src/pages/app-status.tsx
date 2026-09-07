import { useState, type ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleGauge,
  CloudDownload,
  Download,
  Globe2,
  HardDrive,
  Info,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  Wifi,
  WifiOff,
} from "lucide-react"
import { SidebarToggle } from "@/components/layout"
import { useIsOnline } from "@/components/layout/connection-status"
import { ThreaLogo } from "@/components/threa-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  APP_UPDATE_POLL_INTERVAL_MS,
  currentAppBuiltAt,
  currentAppInstalledAt,
  currentAppVersion,
  useAppUpdate,
  useIsServiceWorkerControlled,
} from "@/hooks/use-app-update"
import { formatFullDateTime, formatTime } from "@/lib/dates"
import { cn } from "@/lib/utils"

type AppUpdate = ReturnType<typeof useAppUpdate>
type UpdateStatus = Pick<AppUpdate, "phase" | "failure" | "readyVersion" | "readyBuildId">

/**
 * `readyBuildId` — set only from a worker that reported a complete local build —
 * not `phase`, is what says a reload has somewhere to land: a background check
 * moves the phase off `ready` while that build is still parked.
 */
function hasReadyBuild(status: UpdateStatus): boolean {
  return status.readyBuildId !== null
}

function isActivationFailure(status: UpdateStatus): boolean {
  return (
    status.phase === "failed" && (status.failure === "activation-failed" || status.failure === "activation-timeout")
  )
}

const ACTION_CLASS = "sm:min-w-[11.5rem]"

interface StatusCopy {
  title: string
  description: ReactNode
  icon: typeof CircleGauge
  iconClassName: string
}

function failureCopy(failure: AppUpdate["failure"]): StatusCopy {
  const icon = AlertTriangle
  const iconClassName = "text-destructive"
  if (failure === "download-failed") {
    return {
      title: "Download didn't finish",
      description: "The new build didn't download completely. Threa keeps running the build you have.",
      icon,
      iconClassName,
    }
  }
  if (failure === "activation-failed" || failure === "activation-timeout") {
    return {
      title: "Update didn't start",
      description: "Threa couldn't switch to the downloaded build. The build you have keeps running.",
      icon,
      iconClassName,
    }
  }
  return {
    title: "Couldn't check for updates",
    description: "The update service didn't answer. Threa keeps running the build you have.",
    icon,
    iconClassName,
  }
}

function statusCopy(status: UpdateStatus): StatusCopy {
  const { phase, failure, readyVersion } = status
  if (phase === "applying") {
    return {
      title: "Updating…",
      description: "Switching to the downloaded build. Threa reloads when it takes over.",
      icon: Loader2,
      iconClassName: "animate-spin text-primary",
    }
  }
  if (isActivationFailure(status)) {
    return failureCopy(failure)
  }
  if (hasReadyBuild(status)) {
    return {
      title: "Update ready",
      description: readyVersion ? (
        <>
          Version <span className="font-mono text-foreground">{readyVersion}</span> is downloaded and ready.
        </>
      ) : (
        "A new build is downloaded and ready."
      ),
      icon: Download,
      iconClassName: "text-primary",
    }
  }
  if (phase === "checking") {
    return {
      title: "Checking for updates…",
      description: "Looking for a newer Threa build.",
      icon: Loader2,
      iconClassName: "animate-spin text-primary",
    }
  }
  if (phase === "downloading") {
    return {
      title: "Downloading update…",
      description: "A newer build is downloading in the background. Keep working; Threa asks before switching.",
      icon: CloudDownload,
      iconClassName: "text-primary",
    }
  }
  if (phase === "current") {
    return {
      title: "Up to date",
      description: "You're running the latest available build.",
      icon: CheckCircle2,
      iconClassName: "text-primary",
    }
  }
  if (phase === "offline") {
    return {
      title: "Can't check while offline",
      description: "Reconnect, then try the check again.",
      icon: WifiOff,
      iconClassName: "text-muted-foreground",
    }
  }
  if (phase === "unavailable") {
    return {
      title: "No update ready yet",
      description: "Threa has nothing downloaded to switch to. It keeps checking in the background.",
      icon: CircleGauge,
      iconClassName: "text-muted-foreground",
    }
  }
  if (phase === "failed") {
    return failureCopy(failure)
  }
  return {
    title: "Current installation",
    description: "Threa checks for updates automatically. You can also run a check now.",
    icon: CircleGauge,
    iconClassName: "text-primary",
  }
}

function DetailRow({ icon: Icon, label, children }: { icon: typeof Info; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className="mt-0.5 text-sm text-foreground">{children}</div>
      </div>
    </div>
  )
}

function isStandaloneApp(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean }
  return (
    navigatorWithStandalone.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true
  )
}

function offlineSupportLabel(isControlled: boolean): string {
  if (!("serviceWorker" in navigator)) return "Not supported"
  return isControlled ? "Ready" : "Starting"
}

/**
 * `applying` keeps the button busy until the page navigates: the phase leaves
 * `applying` only on a bounded failure, so no click ever looks unhandled.
 * Without a downloaded build to land on, `apply()` could only fail, so the card
 * offers a check instead.
 */
function UpdateAction({ update }: { update: AppUpdate }) {
  const { phase, check, apply } = update
  if (phase === "applying") {
    return (
      <Button disabled aria-busy="true" className={ACTION_CLASS}>
        <Loader2 className="animate-spin" />
        Updating…
      </Button>
    )
  }

  if (hasReadyBuild(update)) {
    return (
      <Button onClick={() => void apply()} className={ACTION_CLASS}>
        <RefreshCw />
        {isActivationFailure(update) ? "Try again" : "Reload and update"}
      </Button>
    )
  }

  const busy = phase === "checking" || phase === "downloading"
  return (
    <Button
      variant="outline"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => void check()}
      className={ACTION_CLASS}
    >
      {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      {phase === "downloading" ? "Downloading…" : "Check for updates"}
    </Button>
  )
}

export function AppStatusPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const isOnline = useIsOnline()
  const isServiceWorkerControlled = useIsServiceWorkerControlled()
  const update = useAppUpdate()
  const [installedAt] = useState(() => currentAppInstalledAt())
  const copy = statusCopy(update)
  const StatusIcon = copy.icon
  const version = currentAppVersion() ?? "Development"
  const builtAtValue = currentAppBuiltAt()
  const builtAt = builtAtValue && !Number.isNaN(Date.parse(builtAtValue)) ? new Date(builtAtValue) : null

  if (!workspaceId) return null

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 items-center gap-2 border-b px-4">
        <SidebarToggle location="page" />
        <Button asChild variant="ghost" size="icon" className="h-11 w-11">
          <Link to={`/w/${workspaceId}`} aria-label="Back to workspace">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Info className="h-5 w-5 text-muted-foreground" />
          <h1 className="font-semibold">App status</h1>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          <Card className="overflow-hidden">
            <CardContent className="relative p-5 sm:p-6">
              <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-primary" />
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                  <ThreaLogo size="lg" />
                </div>
                <div className="min-w-0 flex-1" role="status" aria-live="polite">
                  <div className="flex items-center gap-2">
                    <StatusIcon className={cn("h-5 w-5 shrink-0", copy.iconClassName)} />
                    <h2 className="font-semibold">{copy.title}</h2>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy.description}</p>
                  {update.lastCheckedAt && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Last checked {formatTime(update.lastCheckedAt)}
                    </p>
                  )}
                </div>
                <UpdateAction update={update} />
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-base">Build details</CardTitle>
                <CardDescription>The version currently running on this device.</CardDescription>
              </CardHeader>
              <CardContent className="divide-y">
                <DetailRow icon={HardDrive} label="Current version">
                  <span className="font-mono tabular-nums">{version}</span>
                </DetailRow>
                <DetailRow icon={RefreshCw} label="Updated on this device">
                  {installedAt ? (
                    <time dateTime={installedAt.toISOString()}>{formatFullDateTime(installedAt)}</time>
                  ) : (
                    "Not available"
                  )}
                </DetailRow>
                <DetailRow icon={CloudDownload} label="Build created">
                  {builtAt ? (
                    <time dateTime={builtAt.toISOString()}>{formatFullDateTime(builtAt)}</time>
                  ) : (
                    "Not available for this build"
                  )}
                </DetailRow>
                <DetailRow icon={Globe2} label="App host">
                  <span className="break-all font-mono text-xs">{window.location.hostname || "Local development"}</span>
                </DetailRow>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-base">Device readiness</CardTitle>
                <CardDescription>Local capabilities that keep Threa available.</CardDescription>
              </CardHeader>
              <CardContent className="divide-y">
                <DetailRow icon={isOnline ? Wifi : WifiOff} label="Connection">
                  <span className={cn(!isOnline && "text-muted-foreground")}>{isOnline ? "Online" : "Offline"}</span>
                </DetailRow>
                <DetailRow icon={CloudDownload} label="Offline support">
                  {offlineSupportLabel(isServiceWorkerControlled)}
                </DetailRow>
                <DetailRow icon={MonitorSmartphone} label="Running as">
                  {isStandaloneApp() ? "Installed app" : "Web browser"}
                </DetailRow>
              </CardContent>
            </Card>
          </div>

          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            Updates are checked every {APP_UPDATE_POLL_INTERVAL_MS / 60_000} minutes, when Threa returns to the
            foreground, and after reconnecting. A downloaded update stays ready until you reload, online or off.
          </p>
        </div>
      </main>
    </div>
  )
}
