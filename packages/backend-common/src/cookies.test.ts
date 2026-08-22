import { describe, expect, test } from "bun:test"
import type { Response } from "express"
import {
  MAX_ACCOUNTS,
  MAX_ALT_SLOTS,
  SessionCookies,
  assertSlot,
  sessionCookieConfigFromEnv,
  type SessionCookieOptions,
} from "./cookies"

type CookieCall =
  | { type: "clear"; name: string; options: SessionCookieOptions }
  | { type: "set"; name: string; value: string; options: SessionCookieOptions }

function makeResponseRecorder(): { res: Response; calls: CookieCall[] } {
  const calls: CookieCall[] = []
  const res = {
    clearCookie(name: string, options: SessionCookieOptions) {
      calls.push({ type: "clear", name, options })
      return this
    },
    cookie(name: string, value: string, options: SessionCookieOptions) {
      calls.push({ type: "set", name, value, options })
      return this
    },
  } as unknown as Response

  return { res, calls }
}

const NAME = "wos_session_test"
const DOMAIN_OPTIONS = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  maxAge: 123,
  domain: ".threa.io",
}
const cookies = new SessionCookies({ name: NAME, options: DOMAIN_OPTIONS })

describe("session cookies", () => {
  test("setting a domain-scoped session first clears a host-only cookie with the same name", () => {
    const { res, calls } = makeResponseRecorder()

    cookies.set(res, "sealed-session")

    expect(calls).toEqual([
      {
        type: "clear",
        name: NAME,
        options: { path: "/", httpOnly: true, secure: true, sameSite: "lax" },
      },
      { type: "set", name: NAME, value: "sealed-session", options: DOMAIN_OPTIONS },
    ])
  })

  test("clearing a domain-scoped session also clears the host-only variant", () => {
    const { res, calls } = makeResponseRecorder()

    cookies.clear(res)

    expect(calls).toEqual([
      {
        type: "clear",
        name: NAME,
        options: { path: "/", httpOnly: true, secure: true, sameSite: "lax", domain: ".threa.io" },
      },
      {
        type: "clear",
        name: NAME,
        options: { path: "/", httpOnly: true, secure: true, sameSite: "lax" },
      },
    ])
  })

  test("read returns the active sealed session and ignores alt cookies", () => {
    expect(cookies.read({ [NAME]: "active", [`${NAME}_alt_0`]: "parked" })).toBe("active")
    expect(cookies.read({ wos_session: "other-env" })).toBeUndefined()
  })

  test("two environments in one process never see each other's cookies", () => {
    const staging = new SessionCookies({ name: "wos_session_staging", options: DOMAIN_OPTIONS })
    const jar = { [NAME]: "prod-active", wos_session_staging: "staging-active" }

    expect(cookies.read(jar)).toBe("prod-active")
    expect(staging.read(jar)).toBe("staging-active")
    expect(staging.altName(0)).toBe("wos_session_staging_alt_0")
  })
})

describe("alt session cookies", () => {
  // The Cookie-header budget guard is enforced at module load (cookies.ts
  // throws if MAX_ACCOUNTS exceeds the documented size), so a successful
  // import already proves the cap fits. This just pins the derivation.
  test("MAX_ALT_SLOTS is always derived as MAX_ACCOUNTS - 1", () => {
    expect(Number.isInteger(MAX_ACCOUNTS)).toBe(true)
    expect(MAX_ACCOUNTS).toBeGreaterThan(0)
    expect(MAX_ALT_SLOTS).toBe(MAX_ACCOUNTS - 1)
  })

  test("assertSlot accepts in-range slots and rejects out-of-range", () => {
    for (let slot = 0; slot < MAX_ALT_SLOTS; slot++) {
      expect(() => assertSlot(slot)).not.toThrow()
    }
    expect(() => assertSlot(-1)).toThrow(RangeError)
    expect(() => assertSlot(MAX_ALT_SLOTS)).toThrow(RangeError)
    expect(() => assertSlot(1.5)).toThrow(RangeError)
    expect(() => assertSlot(Number.NaN)).toThrow(RangeError)
  })

  test("altName derives from the configured base", () => {
    expect(cookies.altName(0)).toBe("wos_session_test_alt_0")
    expect(cookies.altName(MAX_ALT_SLOTS - 1)).toBe(`${NAME}_alt_${MAX_ALT_SLOTS - 1}`)
    expect(() => cookies.altName(MAX_ALT_SLOTS)).toThrow(RangeError)
  })

  test("setAlt mirrors the active-cookie host-only dual-clear under the alt name", () => {
    const { res, calls } = makeResponseRecorder()

    cookies.setAlt(res, 0, "sealed-alt")

    expect(calls).toEqual([
      {
        type: "clear",
        name: "wos_session_test_alt_0",
        options: { path: "/", httpOnly: true, secure: true, sameSite: "lax" },
      },
      { type: "set", name: "wos_session_test_alt_0", value: "sealed-alt", options: DOMAIN_OPTIONS },
    ])
  })

  test("clearAlt clears the alt name and its host-only variant", () => {
    const { res, calls } = makeResponseRecorder()

    cookies.clearAlt(res, 1)

    expect(calls).toEqual([
      {
        type: "clear",
        name: "wos_session_test_alt_1",
        options: { path: "/", httpOnly: true, secure: true, sameSite: "lax", domain: ".threa.io" },
      },
      {
        type: "clear",
        name: "wos_session_test_alt_1",
        options: { path: "/", httpOnly: true, secure: true, sameSite: "lax" },
      },
    ])
  })

  test("readAlts returns only this env's occupied slots, sorted, ignoring active and foreign-env cookies", () => {
    const jar: Record<string, string> = {
      [NAME]: "active-sealed",
      [`${NAME}_alt_1`]: "slot1",
      [`${NAME}_alt_0`]: "slot0",
      [`${NAME}_alt_${MAX_ALT_SLOTS}`]: "out-of-range",
      [`${NAME}_alt_2`]: "",
      wos_session_alt_0: "prod-foreign",
      wos_session_staging_alt_0: "staging-foreign",
      unrelated: "noise",
    }

    expect(cookies.readAlts(jar)).toEqual([
      { slot: 0, sealed: "slot0" },
      { slot: 1, sealed: "slot1" },
    ])
  })
})

describe("sessionCookieConfigFromEnv", () => {
  test("an unset name is a boot failure, not a default that could clobber the prod cookie", () => {
    expect(() => sessionCookieConfigFromEnv({})).toThrow("SESSION_COOKIE_NAME is required")
  })

  test("reads the name, the shared domain and the production secure flag from the environment", () => {
    expect(
      sessionCookieConfigFromEnv({
        SESSION_COOKIE_NAME: "wos_session_staging",
        COOKIE_DOMAIN: ".threa.io",
        NODE_ENV: "production",
      })
    ).toEqual({
      name: "wos_session_staging",
      options: {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 30 * 1000,
        domain: ".threa.io",
      },
    })
  })

  test("omits the domain entirely when COOKIE_DOMAIN is unset, so the cookie stays host-only", () => {
    const config = sessionCookieConfigFromEnv({ SESSION_COOKIE_NAME: "wos_session_dev" })
    expect(config.options).toEqual({
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30 * 1000,
    })
  })
})
