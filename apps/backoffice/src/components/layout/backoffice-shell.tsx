import { type ReactNode } from "react"
import { Link, NavLink, Outlet } from "react-router-dom"
import { LayoutDashboard, Users, MailPlus, ClipboardList } from "lucide-react"
import { ThreaLogo } from "@/components/threa-logo"
import { useAuth } from "@/auth"
import { cn } from "@/lib/utils"
import { MobileUserMenu, SidebarUserMenu } from "./user-menu"

/**
 * Persistent shell for the backoffice. Mirrors the main app's pattern:
 * desktop puts the brand at the top of a left sidebar, nav in the middle,
 * and the signed-in user / sign-out at the bottom — freeing the top of
 * the content column for the page header. Mobile gets a slim header strip
 * with the brand and a sign-out icon, then a horizontal nav strip below.
 */
const NAV_ITEMS: Array<{ to: string; label: string; icon: ReactNode; end?: boolean }> = [
  { to: "/", label: "Overview", icon: <LayoutDashboard className="size-4" />, end: true },
  // `end` is omitted so NavLink treats `/workspaces/:id` as active too.
  { to: "/workspaces", label: "Workspaces", icon: <Users className="size-4" /> },
  { to: "/waitlist", label: "Waitlist", icon: <ClipboardList className="size-4" /> },
  { to: "/invites/workspace-owners", label: "Invitations", icon: <MailPlus className="size-4" /> },
]

export function BackofficeShell() {
  const { user, logout } = useAuth()

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar — brand top, nav middle, user info bottom-left. */}
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-card/60 md:flex">
        <div className="border-b px-5 py-5">
          <Link to="/" className="flex items-center gap-3">
            <ThreaLogo size={30} />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">Threa</span>
              <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Backoffice
              </span>
            </div>
          </Link>
        </div>

        <nav aria-label="Backoffice sections" className="flex-1 px-3 py-4">
          <ul className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={({ isActive }) => railNavLinkClass(isActive)}>
                  {item.icon}
                  {item.label}
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
        {/* Mobile top bar — slim brand line with the account avatar at the right. */}
        <header className="flex items-center justify-between border-b px-4 py-3 md:hidden">
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <ThreaLogo size={22} />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Threa</span>
              <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                Backoffice
              </span>
            </div>
          </Link>
          <MobileUserMenu email={user?.email} name={user?.name} onSignOut={logout} />
        </header>

        {/* Mobile nav strip — collapses on md+ when the sidebar takes over. */}
        <nav aria-label="Backoffice sections" className="border-b px-2 py-2 md:hidden">
          <ul className="flex items-center gap-1 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={({ isActive }) => mobileNavLinkClass(isActive)}>
                  {item.icon}
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="flex-1 px-4 py-6 md:px-10 md:py-10">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function railNavLinkClass(isActive: boolean): string {
  return cn(
    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
  )
}

function mobileNavLinkClass(isActive: boolean): string {
  return cn(
    "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
  )
}
