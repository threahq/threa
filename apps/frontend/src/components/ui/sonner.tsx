import { useEffect, useMemo, useRef } from "react"
import { CircleCheck, Info, LoaderCircle, OctagonX, TriangleAlert } from "lucide-react"
import { SonnerRoot as Sonner, toast, useSonner, type ToastT } from "@/lib/sonner-module"
import { usePreferencesOptional } from "@/contexts"
import { useIsMobile } from "@/hooks/use-mobile"

type ToasterProps = React.ComponentProps<typeof Sonner>
type ToastPosition = NonNullable<ToasterProps["position"]>
type SonnerToast = Pick<ToastT, "id" | "position" | "toasterId">

const MOBILE_TOAST_POSITION: ToastPosition = "top-center"
const DESKTOP_TOAST_POSITION: ToastPosition = "bottom-right"

function groupToastsByPosition(toasts: SonnerToast[], defaultPosition: ToastPosition) {
  const toastsByPosition = new Map<ToastPosition, SonnerToast[]>()

  for (const activeToast of toasts) {
    const position = (activeToast.position ?? defaultPosition) as ToastPosition
    const existingToasts = toastsByPosition.get(position)
    if (existingToasts) {
      existingToasts.push(activeToast)
    } else {
      toastsByPosition.set(position, [activeToast])
    }
  }

  return toastsByPosition
}

const Toaster = ({ ...props }: ToasterProps) => {
  // Outside a workspace there is no provider; index.html already applied the cached appearance to <html>.
  const resolvedTheme =
    usePreferencesOptional()?.resolvedTheme ?? (document.documentElement.classList.contains("dark") ? "dark" : "light")
  const isMobile = useIsMobile()
  const { toasts } = useSonner()
  const toasterRef = useRef<HTMLElement | null>(null)
  const interactionStateRef = useRef<{ filteredToasts: SonnerToast[]; defaultPosition: ToastPosition }>({
    filteredToasts: [],
    defaultPosition: DESKTOP_TOAST_POSITION,
  })
  const toastIdByElementRef = useRef(new WeakMap<HTMLElement, SonnerToast["id"]>())

  const defaultPosition: ToastPosition = props.position ?? (isMobile ? MOBILE_TOAST_POSITION : DESKTOP_TOAST_POSITION)

  const filteredToasts = useMemo<SonnerToast[]>(() => {
    if (props.id) {
      return toasts.filter((activeToast) => activeToast.toasterId === props.id)
    }
    return toasts.filter((activeToast) => !activeToast.toasterId)
  }, [props.id, toasts])

  useEffect(() => {
    interactionStateRef.current = { filteredToasts, defaultPosition }

    const root = toasterRef.current
    if (!root) return
    const nextToastIdMap = new WeakMap<HTMLElement, SonnerToast["id"]>()
    const toastsByPosition = groupToastsByPosition(filteredToasts, defaultPosition)

    for (const [position, toastsAtPosition] of toastsByPosition) {
      const [y, x] = position.split("-")
      const domToastsAtPosition = root.querySelectorAll<HTMLElement>(
        `[data-sonner-toaster][data-y-position="${y}"][data-x-position="${x}"] [data-sonner-toast]`
      )

      domToastsAtPosition.forEach((domToast) => {
        const indexRaw = domToast.dataset.index
        if (!indexRaw) return

        const index = Number.parseInt(indexRaw, 10)
        if (!Number.isFinite(index)) return

        const toastForIndex = toastsAtPosition[index]
        if (!toastForIndex) return

        nextToastIdMap.set(domToast, toastForIndex.id)
      })
    }

    toastIdByElementRef.current = nextToastIdMap
  }, [defaultPosition, filteredToasts])

  useEffect(() => {
    const root = toasterRef.current
    if (!root) return

    const resolveToastIdFromDataset = (toastElement: HTMLElement) => {
      const indexRaw = toastElement.dataset.index
      const y = toastElement.dataset.yPosition
      const x = toastElement.dataset.xPosition
      if (!indexRaw || !y || !x) return undefined

      const index = Number.parseInt(indexRaw, 10)
      if (!Number.isFinite(index)) return undefined

      const clickedPosition = `${y}-${x}` as ToastPosition
      const { filteredToasts: currentFilteredToasts, defaultPosition: currentDefaultPosition } =
        interactionStateRef.current
      const toastsAtPosition = currentFilteredToasts.filter(
        (activeToast) => (activeToast.position ?? currentDefaultPosition) === clickedPosition
      )

      return toastsAtPosition[index]?.id
    }

    const handleToastClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return

      // Keep action/cancel/close controls clickable without dismissing the toast body.
      if (target.closest("button,a,input,textarea,select,label,[role='button']")) return

      const toastElement = target.closest<HTMLElement>("[data-sonner-toast]")
      if (!toastElement || toastElement.dataset.dismissible === "false") return

      const mappedToastId = toastIdByElementRef.current.get(toastElement) ?? resolveToastIdFromDataset(toastElement)
      if (mappedToastId === undefined) return

      toast.dismiss(mappedToastId)
    }

    root.addEventListener("click", handleToastClick)
    return () => root.removeEventListener("click", handleToastClick)
  }, [])

  return (
    <Sonner
      ref={toasterRef}
      theme={resolvedTheme}
      position={defaultPosition}
      mobileOffset={{
        top: "max(12px, env(safe-area-inset-top))",
        left: 12,
        right: 12,
      }}
      className="toaster group"
      icons={{
        success: <CircleCheck className="h-4 w-4" />,
        info: <Info className="h-4 w-4" />,
        warning: <TriangleAlert className="h-4 w-4" />,
        error: <OctagonX className="h-4 w-4" />,
        loading: <LoaderCircle className="h-4 w-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast cursor-pointer data-[dismissible=false]:cursor-default group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
