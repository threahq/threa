import { Link, NavLink, Outlet } from "react-router-dom"
import { LayoutDashboard, Users, MailPlus, ClipboardList, type LucideIcon } from "lucide-react"
import { ThreaLogo } from "@/components/threa-logo"
import { useAuth } from "@/auth"
import { cn } from "@/lib/utils"
import { MobileUserMenu, SidebarUserMenu } from "./user-menu"

/**
 * Persistent shell for the backoffice, drawn like the main app's settings
 * window: a quiet left rail (brand, pages, account) beside the content column.
 * Phones get a sticky header with the brand and account, and the pages as an
 * evenly split tab strip under it.
 */
const NAV_ITEMS: Array<{ to: string; label: string; icon: LucideIcon; end?: boolean }> = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  // `end` is omitted so NavLink treats `/workspaces/:id` as active too.
  { to: "/workspaces", label: "Workspaces", icon: Users },
  { to: "/waitlist", label: "Waitlist", icon: ClipboardList },
  { to: "/invites/workspace-owners", label: "Invitations", icon: MailPlus },
]

export function BackofficeShell() {
  const { user, logout } = useAuth()

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r bg-muted/30 md:flex">
        <div className="px-5 pb-4 pt-5">
          <Brand logoSize={26} />
        </div>

        <nav aria-label="Backoffice sections" className="flex-1 overflow-y-auto px-3 py-2">
          <ul className="flex flex-col gap-0.5">
            {NAV_ITEMS.map(({ to, end, label, icon: Icon }) => (
              <li key={to}>
                <NavLink to={to} end={end} className={({ isActive }) => railNavLinkClass(isActive)}>
                  <Icon aria-hidden className="size-4 shrink-0" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t px-3 py-3">
          <SidebarUserMenu email={user?.email} name={user?.name} onSignOut={logout} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
          <header className="flex items-center justify-between px-4 pb-1 pt-2">
            <Brand logoSize={22} />
            <MobileUserMenu email={user?.email} name={user?.name} onSignOut={logout} />
          </header>
          <nav aria-label="Backoffice sections" className="px-2 pb-1.5">
            <ul className="grid grid-cols-4 gap-1">
              {NAV_ITEMS.map(({ to, end, label, icon: Icon }) => (
                <li key={to} className="min-w-0">
                  <NavLink to={to} end={end} className={({ isActive }) => mobileNavLinkClass(isActive)}>
                    <Icon aria-hidden className="size-[18px] shrink-0" />
                    <span className="max-w-full truncate">{label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <main className="flex-1 px-4 pb-16 pt-6 sm:px-6 md:px-10 md:pt-10">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function Brand({ logoSize }: { logoSize: number }) {
  return (
    <Link
      to="/"
      className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ThreaLogo size={logoSize} />
      <span className="text-base font-semibold tracking-tight text-foreground">Threa</span>
      <span className="rounded-full border px-2 py-px text-xs font-medium leading-5 text-muted-foreground">
        Backoffice
      </span>
    </Link>
  )
}

function railNavLinkClass(isActive: boolean): string {
  return cn(
    "flex min-h-9 items-center gap-2.5 rounded-md px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    isActive
      ? "bg-accent font-medium text-accent-foreground"
      : "text-foreground/80 hover:bg-muted hover:text-foreground [&>svg]:text-muted-foreground"
  )
}

function mobileNavLinkClass(isActive: boolean): string {
  return cn(
    "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    isActive ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground active:bg-muted"
  )
}
