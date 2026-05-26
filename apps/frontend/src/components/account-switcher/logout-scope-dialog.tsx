import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { LogOut, Users } from "lucide-react"
import { accountsApi } from "@/api"
import { useAuth } from "@/auth"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"

const ACCOUNTS_LIST_KEY = ["accounts", "list"]
const SEARCH_PARAM = "logout-confirm"

/**
 * Confirm dialog shown when the user clicks "Log out" with more than one
 * account signed in on this browser. Lets them pick between signing out of
 * just the active account (the parked alt is promoted in its place, no full
 * logout) or every account on this browser (the existing scope=all behavior).
 *
 * Mounted globally alongside `AccountSwitcherDialog`. Opens via the
 * `?logout-confirm` search param so the sidebar menu can defer the decision
 * to the dialog without owning any state itself.
 */
export function LogoutScopeDialog() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [mounted, setMounted] = useState(false)
  const isOpen = searchParams.get(SEARCH_PARAM) !== null
  const { logout, user } = useAuth()

  // Mirror AccountSwitcherDialog: defer until after hydration so the
  // ResponsiveDialog doesn't briefly mount on the server-shaped tree.
  useEffect(() => {
    setMounted(true)
  }, [])

  const { data, isLoading } = useQuery({
    queryKey: ACCOUNTS_LIST_KEY,
    queryFn: () => accountsApi.list(),
    enabled: isOpen,
  })

  if (!mounted) return null

  const close = () => {
    const next = new URLSearchParams(searchParams)
    next.delete(SEARCH_PARAM)
    setSearchParams(next, { replace: true })
  }

  const liveAccounts = data?.accounts.filter((a) => a.state !== "stale") ?? []
  const otherCount = Math.max(0, liveAccounts.length - 1)
  const activeLabel = user?.email || user?.name || "this account"

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md p-0 gap-0" drawerClassName="flex flex-col gap-0">
        <ResponsiveDialogHeader className="border-b px-4 py-4 sm:px-6 sm:py-5">
          <ResponsiveDialogTitle>Log out</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            You&apos;re signed in to more than one account on this browser. What would you like to do?
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="flex flex-col gap-2 px-4 py-4 sm:px-6">
          {isLoading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => logout({ scope: "current" })}
                className="flex w-full items-start gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/60"
              >
                <LogOut className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Sign out of {activeLabel}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {otherCount > 0
                      ? `You'll stay signed in to the other ${otherCount === 1 ? "account" : `${otherCount} accounts`} on this browser.`
                      : "You'll stay signed in to your other account on this browser."}
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => logout({ scope: "all" })}
                className="flex w-full items-start gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/60"
              >
                <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">Sign out of all accounts</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Empties the cookie jar for every signed-in account on this browser.
                  </p>
                </div>
              </button>

              <Button variant="ghost" className="mt-1 w-full" onClick={close}>
                Cancel
              </Button>
            </>
          )}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
