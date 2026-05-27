import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Trash2, UserPlus } from "lucide-react"
import { toast } from "sonner"
import { ACCOUNTS_LIST_KEY, accountsApi, type AccountSummary } from "@/api"
import { useAccountScope, useAuth } from "@/auth"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { getInitials } from "@/lib/initials"

const SEARCH_PARAM = "account-switcher"

interface AccountRowProps {
  account: AccountSummary
  onSwitch: (id: string) => void
  onRemove: (id: string) => void
  onReauth: () => void
}

function AccountRow({ account, onSwitch, onRemove, onReauth }: AccountRowProps) {
  if (account.state === "stale") {
    return (
      <div className="flex items-center gap-2 rounded-lg px-3 py-2.5">
        <Avatar className="h-9 w-9">
          <AvatarFallback>?</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">Signed-out account</p>
          <p className="truncate text-xs text-muted-foreground">Session expired — sign in again</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onReauth}>
          <UserPlus className="mr-1.5 h-4 w-4" />
          Add an account
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${account.email || account.id || "account"}`}
          onClick={() => onRemove(account.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  const initials = getInitials(account.name || account.email) || "?"

  if (account.state === "active") {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2.5">
        <Avatar className="h-9 w-9">
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{account.name}</p>
          <p className="truncate text-xs text-muted-foreground">{account.email}</p>
        </div>
        <Check className="h-4 w-4 shrink-0 text-primary" aria-label="Current account" />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onSwitch(account.id)}
        className="flex flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left ring-offset-background transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Avatar className="h-9 w-9">
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{account.name}</p>
          <p className="truncate text-xs text-muted-foreground">{account.email}</p>
        </div>
      </button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Remove ${account.name || account.email || account.id || "account"}`}
        onClick={() => onRemove(account.id)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

function AccountListSkeleton() {
  return (
    <div className="flex flex-col gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function AccountSwitcherDialog() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [mounted, setMounted] = useState(false)
  const isOpen = searchParams.get(SEARCH_PARAM) !== null

  const { login } = useAuth()
  const scope = useAccountScope()
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery({
    queryKey: ACCOUNTS_LIST_KEY,
    queryFn: () => accountsApi.list(),
    enabled: isOpen,
  })

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  const close = () => {
    const next = new URLSearchParams(searchParams)
    next.delete(SEARCH_PARAM)
    setSearchParams(next, { replace: true })
  }

  const accounts = data?.accounts ?? []
  const maxAccounts = data?.maxAccounts ?? accounts.length
  const canAddAccount = accounts.length < maxAccounts

  const addAccount = () => {
    login(undefined, { intent: "add" })
  }

  const handleSwitch = async (id: string) => {
    try {
      await scope.switchAccount(id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to switch account")
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await accountsApi.remove(id)
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_LIST_KEY })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove account")
    }
  }

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md p-0 gap-0" drawerClassName="flex flex-col gap-0">
        <ResponsiveDialogHeader className="border-b px-4 py-4 sm:px-6 sm:py-5">
          <ResponsiveDialogTitle>Switch account</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Switch between, add, or remove the accounts signed in on this browser.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="py-3">
          {isLoading && <AccountListSkeleton />}
          {isError && (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Couldn&apos;t load your accounts. Close and try again.
            </p>
          )}
          {!isLoading && !isError && (
            <div className="flex flex-col gap-1">
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  onSwitch={handleSwitch}
                  onRemove={handleRemove}
                  onReauth={addAccount}
                />
              ))}
            </div>
          )}
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter className="border-t px-4 py-3 sm:px-6">
          <Button variant="outline" className="w-full" onClick={addAccount} disabled={!canAddAccount}>
            <UserPlus className="mr-2 h-4 w-4" />
            Add account
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
