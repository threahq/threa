import type { ReactElement, ReactNode } from "react"
import { render, type RenderOptions } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

/**
 * Wrapper component for tests that need common providers.
 * Mirrors the minimum set of providers wired at the App root that are
 * ambient, safe to mount everywhere, and needed by shared UI primitives
 * (Tooltip, in particular, is a hard dependency of layout components like
 * SidebarToggle and the page headers).
 */
function TestProviders({ children }: { children: ReactNode }) {
  return <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
}

/**
 * Custom render function that wraps components with test providers.
 * Use this instead of @testing-library/react's render for integration tests.
 *
 * @example
 * ```tsx
 * import { renderWithProviders, screen } from "@/test"
 *
 * it("should render", () => {
 *   renderWithProviders(<MyComponent />)
 *   expect(screen.getByText("Hello")).toBeInTheDocument()
 * })
 * ```
 */
export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { wrapper: TestProviders, ...options })
}

export * from "@testing-library/react"
export { default as userEvent } from "@testing-library/user-event"

export { renderWithProviders as render }
