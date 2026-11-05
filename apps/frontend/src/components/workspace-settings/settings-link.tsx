import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useSettingHref } from "@/hooks/use-setting-href"
import type { SettingId } from "@/components/settings/settings-registry"
import { useSettingsLinkHistory, type SettingsLinkHistory } from "@/components/settings/settings-link-history"

const SETTINGS_LINK_CLASS =
  "relative rounded-sm font-medium text-foreground underline underline-offset-2 after:absolute after:-inset-x-1 after:-inset-y-3.5 after:content-[''] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:after:hidden [@media(pointer:coarse)]:after:block"

/**
 * An inline link to another setting in the settings window: one of yours or
 * the workspace's by id (the page comes from the registry), or a stream page
 * by url. On phones and touch screens its hit area grows to 44px tall
 * without moving the text around it. It moves within the window as every
 * in-window link does; `leavesWindow` for a link to somewhere else.
 */
export function SettingsLink(
  props: { children: ReactNode; leavesWindow?: boolean } & ({ setting: SettingId } | { to: string })
) {
  const inWindow = useSettingsLinkHistory()
  const history: SettingsLinkHistory = props.leavesWindow ? {} : inWindow
  if ("to" in props) {
    return (
      <HistoryLink to={props.to} history={history}>
        {props.children}
      </HistoryLink>
    )
  }
  return (
    <RegistrySettingsLink setting={props.setting} history={history}>
      {props.children}
    </RegistrySettingsLink>
  )
}

function RegistrySettingsLink({
  setting,
  history,
  children,
}: {
  setting: SettingId
  history: SettingsLinkHistory
  children: ReactNode
}) {
  const href = useSettingHref(setting)
  if (!href) return <>{children}</>
  return (
    <HistoryLink to={href} history={history}>
      {children}
    </HistoryLink>
  )
}

function HistoryLink({ to, history, children }: { to: string; history: SettingsLinkHistory; children: ReactNode }) {
  return (
    <Link to={to} state={history.state} className={SETTINGS_LINK_CLASS}>
      {children}
    </Link>
  )
}
