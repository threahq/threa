import { describe, expect, spyOn, test } from "bun:test"
import { logger } from "../logger"
import { loadPostHogConfig } from "./config"

describe("loadPostHogConfig", () => {
  test("should return a config when both token and host are set", () => {
    const config = loadPostHogConfig(
      { POSTHOG_PROJECT_TOKEN: " phc_abc ", POSTHOG_HOST: " https://eu.i.posthog.com " },
      { isProduction: false, service: "backend" }
    )

    expect(config).toEqual({ projectToken: "phc_abc", host: "https://eu.i.posthog.com", logsLevel: null })
  })

  test("should read POSTHOG_LOGS_LEVEL when it names a pino level", () => {
    const config = loadPostHogConfig(
      {
        POSTHOG_PROJECT_TOKEN: "phc_abc",
        POSTHOG_HOST: "https://eu.i.posthog.com",
        POSTHOG_LOGS_LEVEL: " warn ",
      },
      { isProduction: false, service: "backend" }
    )

    expect(config).toEqual({ projectToken: "phc_abc", host: "https://eu.i.posthog.com", logsLevel: "warn" })
  })

  test("should throw when POSTHOG_LOGS_LEVEL is not a pino level", () => {
    expect(() =>
      loadPostHogConfig(
        {
          POSTHOG_PROJECT_TOKEN: "phc_abc",
          POSTHOG_HOST: "https://eu.i.posthog.com",
          POSTHOG_LOGS_LEVEL: "verbose",
        },
        { isProduction: false, service: "backend" }
      )
    ).toThrow('POSTHOG_LOGS_LEVEL must be one of trace, debug, info, warn, error, fatal — got "verbose"')
  })

  test("should throw when POSTHOG_LOGS_LEVEL is not a pino level and no credentials are set", () => {
    expect(() =>
      loadPostHogConfig({ POSTHOG_LOGS_LEVEL: "verbose" }, { isProduction: false, service: "backend" })
    ).toThrow('POSTHOG_LOGS_LEVEL must be one of trace, debug, info, warn, error, fatal — got "verbose"')
  })

  test("should throw when the token is set without a host", () => {
    expect(() =>
      loadPostHogConfig({ POSTHOG_PROJECT_TOKEN: "phc_abc" }, { isProduction: false, service: "backend" })
    ).toThrow(
      "POSTHOG_HOST is required when POSTHOG_PROJECT_TOKEN is set — the host is region-bound (https://eu.i.posthog.com or https://us.i.posthog.com)"
    )
  })

  test("should throw when the host is set without a token", () => {
    expect(() =>
      loadPostHogConfig({ POSTHOG_HOST: "https://eu.i.posthog.com" }, { isProduction: false, service: "backend" })
    ).toThrow(/POSTHOG_PROJECT_TOKEN is required/)
  })

  test("should return null and warn when neither is set in production", () => {
    const warnSpy = spyOn(logger, "warn")

    const config = loadPostHogConfig({}, { isProduction: true, service: "backend" })

    expect(config).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      { service: "backend" },
      "POSTHOG_PROJECT_TOKEN unset — error reporting to PostHog disabled"
    )
    warnSpy.mockRestore()
  })

  test("should return null without warning when neither is set outside production", () => {
    const warnSpy = spyOn(logger, "warn")

    const config = loadPostHogConfig({}, { isProduction: false, service: "backend" })

    expect(config).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
