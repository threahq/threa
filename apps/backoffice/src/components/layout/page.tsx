import { type ReactNode } from "react"

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-10">{children}</div>
}
