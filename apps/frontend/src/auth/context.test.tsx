import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { act, render, screen, spyOnExport, waitFor } from "@/test"
import { AuthProvider, useAuth } from "@/auth"
import * as dbModule from "@/db"
import * as diagnosticsModule from "@/lib/connectivity-diagnostics/facade"
import { getAssertedAccount, reportAccountMismatch, setAssertedAccount } from "@/api/account-assertion"

let triggerLogout: () => void
let captureLogin: ReturnType<typeof useAuth>["login"]

function LoginProbe() {
  captureLogin = useAuth().login
  return null
}

function LogoutProbe() {
  triggerLogout = useAuth().logout
  return null
}

let captureActivateAccount: ReturnType<typeof useAuth>["activateAccount"]

function SessionProbe() {
  const { activeWorkosUserId, user, activateAccount } = useAuth()
  captureActivateAccount = activateAccount
  return (
    <>
      <span data-testid="active">{activeWorkosUserId ?? "unresolved"}</span>
      <span data-testid="identity">{user?.name ?? "unresolved"}</span>
    </>
  )
}

describe("AuthProvider logout", () => {
  const originalLocation = window.location
  const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")

  beforeEach(() => {
    vi.useFakeTimers()

    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "" } as Location,
    })

    // The mount effect calls /api/auth/me; keep it from throwing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) }) as unknown as Response)
    )

    spyOnExport(dbModule, "clearAllCachedData").mockReturnValue((async () => {}) as typeof dbModule.clearAllCachedData)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
    if (originalServiceWorker) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorker)
    } else {
      // @ts-expect-error — jsdom has no serviceWorker by default; remove our stub
      delete navigator.serviceWorker
    }
  })

  it("redirects to the logout endpoint even when navigator.serviceWorker.ready never resolves", async () => {
    const suspend = vi.spyOn(diagnosticsModule, "suspendConnectivityDiagnostics")
    // Reproduces the desktop dev failure: an injectManifest module SW stranded
    // in "installing" means navigator.serviceWorker.ready never settles. The
    // push-cleanup step must not be able to block the logout redirect.
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: new Promise<never>(() => {}) },
    })

    render(
      <AuthProvider>
        <LogoutProbe />
      </AuthProvider>
    )

    await act(async () => {
      triggerLogout()
    })
    expect(suspend).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(window.location.href).toBe("/api/auth/logout")
  })
})

describe("AuthProvider login / accountError", () => {
  const originalLocation = window.location
  let hrefValues: string[]

  function stubLocation(search: string) {
    hrefValues = []
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        pathname: "/w/workspace_1",
        search,
        hash: "",
        set href(v: string) {
          hrefValues.push(v)
        },
        get href() {
          return hrefValues[hrefValues.length - 1] ?? ""
        },
      } as unknown as Location,
    })
  }

  beforeEach(() => {
    captureLogin = undefined as unknown as ReturnType<typeof useAuth>["login"]
    // The mount effect calls /api/auth/me; keep it from throwing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) }) as unknown as Response)
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
  })

  it("routes intent=add to the in-app add-account picker", async () => {
    stubLocation("")
    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>
    )

    await act(async () => {
      captureLogin(undefined, { intent: "add" })
    })

    // The picker bypasses AuthKit — AuthKit's hosted UI silent-refreshes and
    // can't reliably show an account picker. The page itself routes the user
    // to a provider-direct OAuth URL or magic-auth verify.
    expect(hrefValues[hrefValues.length - 1]).toBe("/add-account")
  })

  it("builds a plain login URL with no options", async () => {
    stubLocation("")
    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>
    )

    await act(async () => {
      captureLogin()
    })

    expect(hrefValues[hrefValues.length - 1]).toBe("/api/auth/login")
  })

  it("surfaces accountError once and strips the param", async () => {
    stubLocation("?accountError=MAX_ACCOUNTS_REACHED&foo=bar")
    const toastSpy = vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)
    const replaceSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {})

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        "You're signed in to the maximum number of accounts. Remove one to add another."
      )
    })
    expect(replaceSpy).toHaveBeenCalledWith(null, "", "/w/workspace_1?foo=bar")
  })

  it("strips the accountAdded param and leaves the other accounts' pointers alone", async () => {
    stubLocation("?accountAdded=1&foo=bar")
    // The added account has no pointer of its own yet, and the previous
    // account's is keyed to that account — nothing to invalidate.
    localStorage.setItem("threa-last-workspace:workos_prev", "workspace_old")
    const replaceSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {})

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith(null, "", "/w/workspace_1?foo=bar")
    })
    expect(localStorage.getItem("threa-last-workspace:workos_prev")).toBe("workspace_old")
  })

  it("does not toast when there is no accountError param", async () => {
    stubLocation("?foo=bar")
    const toastSpy = vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(toastSpy).not.toHaveBeenCalled()
  })
})

describe("AuthProvider add-account return", () => {
  const originalLocation = window.location

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { pathname: "/workspaces", search: "?accountAdded=1", hash: "", href: "" } as unknown as Location,
    })
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {})
    // This browser was signed in as the *previous* account right up to the
    // redirect, so both its pointer and its cached identity are still here.
    localStorage.setItem("threa-active-account", "workos_prev")
    localStorage.setItem(
      "threa-account-identity:workos_prev",
      JSON.stringify({ id: "workos_prev", email: "prev@example.com", name: "Previous Account" })
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            json: async () => ({ id: "workos_added", email: "added@example.com", name: "Added Account" }),
          }) as unknown as Response
      )
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
  })

  it("resolves the added account from the credential instead of the stale active pointer", async () => {
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>
    )

    // The add changed the session cookie out of band: publishing the stored
    // pointer here would mount the previous account's identity and storage
    // scope under the added account's credential.
    expect(screen.getByTestId("active")).toHaveTextContent("unresolved")
    expect(screen.getByTestId("identity")).toHaveTextContent("unresolved")

    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent("workos_added")
    })
    expect(screen.getByTestId("identity")).toHaveTextContent("Added Account")
  })
})

describe("AuthProvider account assertion", () => {
  beforeEach(() => {
    localStorage.setItem("threa-active-account", "workos_a")
    localStorage.setItem(
      "threa-account-identity:workos_a",
      JSON.stringify({ id: "workos_a", email: "a@example.com", name: "Account A" })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    setAssertedAccount(null)
    localStorage.clear()
  })

  it("should state the cached account on requests made by the very first render", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ id: "workos_a" }) }) as unknown as Response)
    )

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>
    )

    expect(getAssertedAccount()).toBe("workos_a")
  })

  it("should adopt the account the server names when a refused request reveals this tab is behind", async () => {
    // This tab resolved as A. While it was suspended another tab switched the
    // browser to B, so its next request is refused and it must catch up.
    const identities = [
      { id: "workos_a", email: "a@example.com", name: "Account A" },
      { id: "workos_b", email: "b@example.com", name: "Account B" },
    ]
    let answered = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = identities[Math.min(answered, identities.length - 1)]
        answered += 1
        return { status: 200, ok: true, json: async () => body } as unknown as Response
      })
    )

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>
    )
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("workos_a"))

    await act(async () => {
      reportAccountMismatch()
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("workos_b"))
    expect(screen.getByTestId("identity")).toHaveTextContent("Account B")
    expect(getAssertedAccount()).toBe("workos_b")
  })

  it("should adopt the account the server names when a switch this tab started lost the race", async () => {
    // Two tabs switched at once and this one lost: the cookie names B, not the
    // C this tab activated. Without the refusal outranking the pending
    // expectation the tab would keep asserting C, be refused again, and spin.
    let answered = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        answered += 1
        return {
          status: 200,
          ok: true,
          json: async () => ({ id: "workos_b", email: "b@example.com", name: "Account B" }),
        } as unknown as Response
      })
    )

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>
    )
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("workos_b"))

    await act(async () => {
      captureActivateAccount("workos_c")
      await Promise.resolve()
    })
    // The expectation is pending and the server keeps naming B, so the switch
    // itself does not resolve — the tab still asserts C and gets refused.
    await waitFor(() => expect(getAssertedAccount()).toBe("workos_c"))

    const beforeRevalidation = answered
    await act(async () => {
      reportAccountMismatch()
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("workos_b"))
    expect({ asserted: getAssertedAccount(), extraFetches: answered - beforeRevalidation }).toEqual({
      asserted: "workos_b",
      extraFetches: 1,
    })
  })

  it("should resolve a switch the cookie never confirms, with no further request to prompt it", async () => {
    // The destination never becomes the cookie's account (the switch call
    // failed after this tab activated, or another tab won the race). Nothing
    // else in the app is guaranteed to issue a request that gets refused, so
    // without a bounded resolution here the account stays unresolved forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            json: async () => ({ id: "workos_a", email: "a@example.com", name: "Account A" }),
          }) as unknown as Response
      )
    )
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => "id")

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>
    )
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("workos_a"))

    await act(async () => {
      captureActivateAccount("workos_c")
      await Promise.resolve()
    })
    expect(getAssertedAccount()).toBe("workos_c")

    // No 409, no user gesture, no other request: only the provider's own
    // bounded retries move this forward.
    await waitFor(
      () => {
        expect(screen.getByTestId("active")).toHaveTextContent("workos_a")
      },
      { timeout: 4000 }
    )
    expect({ asserted: getAssertedAccount(), told: toastError.mock.calls.length > 0 }).toEqual({
      asserted: "workos_a",
      told: true,
    })
  })

  it("should not let a stale retry publish over an account activated during the wait", async () => {
    // Two switches in quick succession. The first expectation's retry must not
    // outlive it and resolve on behalf of the second.
    const answers: Record<string, { id: string; email: string; name: string }> = {
      first: { id: "workos_a", email: "a@example.com", name: "Account A" },
      second: { id: "workos_d", email: "d@example.com", name: "Account D" },
    }
    let phase: "first" | "second" = "first"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, ok: true, json: async () => answers[phase] }) as unknown as Response)
    )
    vi.spyOn(toast, "error").mockImplementation(() => "id")

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>
    )
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("workos_a"))

    await act(async () => {
      captureActivateAccount("workos_c")
      await Promise.resolve()
    })
    phase = "second"
    await act(async () => {
      captureActivateAccount("workos_d", { id: "workos_d", email: "d@example.com", name: "Account D" })
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("Account D"))
    // Long enough for the first expectation's retries to have fired had they
    // survived it — the second switch owns the account now.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600))
    })
    expect({ active: screen.getByTestId("active").textContent, asserted: getAssertedAccount() }).toEqual({
      active: "workos_d",
      asserted: "workos_d",
    })
  })

  it("should stop asserting an account once the session is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) }) as unknown as Response)
    )

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>
    )

    await waitFor(() => expect(getAssertedAccount()).toBeNull())
  })
})
