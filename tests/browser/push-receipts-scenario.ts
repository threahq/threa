import { createECDH, createHash, randomBytes } from "crypto"
import { test, expect, type BrowserContext, type CDPSession, type Page, type Worker } from "@playwright/test"
import { devLogin, expectApiOk, generateTestId, waitForWorkspaceProvisioned } from "./helpers"
import { runTestSql } from "./global-setup"

/**
 * Push receipts through the production service worker, driven from the real
 * Settings page. Shared by the desktop and Android spec files: an Android
 * worker needs a browser-level user agent, which only a launch option (one per
 * spec file) can set.
 *
 * Headless Chromium has no push service, so two seams stand in for the
 * provider leg and nothing else:
 * - the page's PushManager hands the app a subscription whose keys this spec
 *   generated, pointing at an unresolvable host. The app's own subscribe flow,
 *   including the receipt-capability handshake with the active worker, runs
 *   unchanged, and the backend's send fails as `unreachable`.
 * - CDP `ServiceWorker.deliverPushMessage` plays the push the provider would
 *   have delivered. Its receipt token replaces the stored hash for this test's
 *   device, since the real token only ever travelled inside the lost payload.
 *
 * Everything after that is real: the built worker creates the notification,
 * reports to the same-origin route without cookies, the backend records it,
 * and Settings shows it next to the provider result. A positive control makes
 * the no-cookie check meaningful: the same worker, asked to include
 * credentials, is seen by the same route observer carrying a known cookie.
 *
 * Two more branches run against the real page: a push for the stream the
 * focused, recently used page is showing is suppressed for presence, and a
 * push whose `showNotification` rejects (the one browser boundary patched,
 * from the test, for one tag) reports `creation_failed`.
 *
 * Needs the production build: `PLAYWRIGHT_PROD_FRONTEND=1` locally, CI default.
 */

const RECEIPT_PATH_RE = /\/api\/workspaces\/[^/]+\/push\/receipts$/
const SENTINEL_COOKIE = "threa_receipt_spec_sentinel"
const PUSH_LIFETIME_OBSERVER = "__threaSpecPushLifetimes"

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url")
}

async function installPushManagerStub(context: BrowserContext, endpoint: string): Promise<void> {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  await context.addInitScript(
    ({ endpoint, p256dh, auth }) => {
      let current: PushSubscription | null = null
      PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
        const applicationServerKey = (options?.applicationServerKey ?? null) as ArrayBuffer | null
        current = {
          endpoint,
          expirationTime: null,
          options: { userVisibleOnly: true, applicationServerKey },
          getKey: () => null,
          toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
          unsubscribe: async () => {
            current = null
            return true
          },
        } as unknown as PushSubscription
        return current
      }
      PushManager.prototype.getSubscription = async function () {
        return current
      }
    },
    { endpoint, p256dh: base64url(ecdh.getPublicKey()), auth: base64url(randomBytes(16)) }
  )
}

async function activeRegistrationId(cdp: CDPSession, origin: string): Promise<string> {
  const registrations = new Map<string, { scopeURL: string; isDeleted: boolean }>()
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: updated }) => {
    for (const r of updated) registrations.set(r.registrationId, r)
  })
  await cdp.send("ServiceWorker.enable")
  let id: string | undefined
  await expect
    .poll(() => {
      id = [...registrations].find(([, r]) => r.scopeURL === `${origin}/` && !r.isDeleted)?.[0]
      return id
    })
    .toBeTruthy()
  return id!
}

/**
 * The backend's wire shape: display fields in `data`, the capability beside it.
 * CDP returns once the message is queued, not after the worker handled it.
 */
async function deliverPush(
  cdp: CDPSession,
  origin: string,
  registrationId: string,
  data: object,
  receiptToken?: string
): Promise<void> {
  const payload = receiptToken ? { data, receipt: { token: receiptToken } } : { data }
  await cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId, data: JSON.stringify(payload) })
}

async function notifications(page: Page, tag: string) {
  return page.evaluate(async (t) => {
    const registration = await navigator.serviceWorker.ready
    return (await registration.getNotifications({ tag: t })).map((n) => ({
      title: n.title,
      dataKeys: Object.keys(n.data ?? {}).sort(),
      actions: ((n as Notification & { actions?: Array<{ action: string }> }).actions ?? []).map((a) => a.action),
    }))
  }, tag)
}

function newToken(): string {
  return base64url(randomBytes(32))
}

/** The Playwright handle on the worker that controls the page, not merely some worker in the context. */
async function controllingWorker(page: Page, context: BrowserContext): Promise<Worker> {
  const scriptURL = await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL)
  let worker: Worker | undefined
  await expect
    .poll(() => {
      worker = context.serviceWorkers().find((w) => w.url() === scriptURL)
      return worker?.url()
    })
    .toBe(scriptURL)
  return worker!
}

/**
 * Test-only view of each push event's lifetime inside the worker. Records
 * every promise a push event passes to `waitUntil`, keyed by the payload's
 * `data.streamId` (or `data.kind`), and marks the event dispatched from a
 * listener added after the app's, so the app's synchronous section has run by
 * then. It changes no behavior: the original `waitUntil` still receives every
 * promise. `drain` resolves once the named pushes were dispatched and every
 * promise they retained, including ones added while earlier ones were still
 * pending, has settled; after that the event can extend no further.
 */
async function installPushLifetimeObserver(worker: Worker): Promise<void> {
  await worker.evaluate((name) => {
    type Entry = { dispatched: boolean; promises: Promise<unknown>[] }
    const scope = self as unknown as Record<string, unknown> & ServiceWorkerGlobalScope
    const entries = new Map<string, Entry>()
    const keyOf = (event: ExtendableEvent): string | null => {
      try {
        const payload = (event as PushEvent).data?.json() as { data?: { streamId?: string; kind?: string } } | undefined
        return payload?.data?.streamId ?? payload?.data?.kind ?? null
      } catch {
        return null
      }
    }
    const entryOf = (key: string): Entry => {
      let entry = entries.get(key)
      if (!entry) {
        entry = { dispatched: false, promises: [] }
        entries.set(key, entry)
      }
      return entry
    }
    const original = ExtendableEvent.prototype.waitUntil
    ExtendableEvent.prototype.waitUntil = function (this: ExtendableEvent, promise: Promise<unknown>) {
      const key = this.type === "push" ? keyOf(this) : null
      if (key !== null) entryOf(key).promises.push(Promise.resolve(promise))
      return original.call(this, promise)
    }
    const onPush = (event: Event) => {
      const key = keyOf(event as ExtendableEvent)
      if (key !== null) entryOf(key).dispatched = true
    }
    scope.addEventListener("push", onPush)
    scope[name] = {
      async drain(keys: string[], timeoutMs: number): Promise<Record<string, number>> {
        const deadline = Date.now() + timeoutMs
        while (!keys.every((key) => entries.get(key)?.dispatched)) {
          if (Date.now() > deadline)
            throw new Error(`push not dispatched: ${keys.filter((k) => !entries.get(k)?.dispatched)}`)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        const all = () => [...entries.values()].flatMap((entry) => entry.promises)
        let seen = -1
        while (seen !== all().length) {
          seen = all().length
          await Promise.allSettled(all())
        }
        return Object.fromEntries([...entries].map(([key, entry]) => [key, entry.promises.length]))
      },
      uninstall() {
        ExtendableEvent.prototype.waitUntil = original
        scope.removeEventListener("push", onPush)
        delete scope[name]
      },
    }
  }, PUSH_LIFETIME_OBSERVER)
}

async function drainPushes(worker: Worker, keys: string[]): Promise<Record<string, number>> {
  return worker.evaluate(
    ({ name, keys }) =>
      (self as unknown as Record<string, { drain(k: string[], t: number): Promise<Record<string, number>> }>)[
        name
      ]!.drain(keys, 15_000),
    { name: PUSH_LIFETIME_OBSERVER, keys }
  )
}

async function uninstallPushLifetimeObserver(worker: Worker): Promise<void> {
  await worker.evaluate(
    (name) => (self as unknown as Record<string, { uninstall(): void } | undefined>)[name]?.uninstall(),
    PUSH_LIFETIME_OBSERVER
  )
}

/** Makes `showNotification` reject for one tag only, the way a platform refusal would. Returns the undo. */
async function failNotificationsTagged(worker: Worker, tag: string): Promise<() => Promise<void>> {
  await worker.evaluate((failTag) => {
    const proto = ServiceWorkerRegistration.prototype as ServiceWorkerRegistration & {
      __specOriginalShow?: ServiceWorkerRegistration["showNotification"]
    }
    const original = proto.showNotification
    proto.__specOriginalShow = original
    proto.showNotification = function (this: ServiceWorkerRegistration, title: string, options?: NotificationOptions) {
      if (options?.tag === failTag) return Promise.reject(new TypeError("spec: notification refused"))
      return original.call(this, title, options)
    }
  }, tag)
  return async () => {
    await worker.evaluate(() => {
      const proto = ServiceWorkerRegistration.prototype as ServiceWorkerRegistration & {
        __specOriginalShow?: ServiceWorkerRegistration["showNotification"]
      }
      if (proto.__specOriginalShow) proto.showNotification = proto.__specOriginalShow
      delete proto.__specOriginalShow
    })
  }
}

/** Sign in and create a workspace without relying on desktop-only chrome, so a phone context works too. */
async function signInToNewWorkspace(page: Page): Promise<string> {
  const testId = generateTestId()
  await devLogin(page, `push-receipts-${testId}@example.com`, `push-receipts ${testId}`)
  const response = await page.request.post("/api/workspaces", { data: { name: `push-receipts WS ${testId}` } })
  await expectApiOk(response, "Workspace creation")
  const workspaceId = ((await response.json()) as { workspace: { id: string } }).workspace.id
  await waitForWorkspaceProvisioned(page, workspaceId)
  await page.goto(`/w/${workspaceId}`)
  return workspaceId
}

export interface ReceiptScenarioDevice {
  name: string
  /** What the worker's own user agent must look like, and the buttons a message card then carries. */
  workerUserAgent: RegExp
  messageActions: string[]
}

export async function deviceReportScenario(
  page: Page,
  context: BrowserContext,
  device: ReceiptScenarioDevice
): Promise<void> {
  test.setTimeout(120_000)
  const endpointId = base64url(randomBytes(8))
  const endpoint = `https://push.invalid/receipt-spec/${endpointId}`
  const baseURL = test.info().project.use.baseURL!
  const origin = new URL(baseURL).origin
  await context.grantPermissions(["notifications"], { origin })
  await installPushManagerStub(context, endpoint)

  // Cookie presence only: values never reach an assertion message. The entry
  // is recorded before the header lookup, so counting never waits on CDP.
  const receipts: Array<{
    body: { token: string; stage: string; reason?: string }
    cookie: boolean | null
    sentinel: boolean | null
  }> = []
  await context.route(RECEIPT_PATH_RE, async (route) => {
    const request = route.request()
    const entry = { body: request.postDataJSON(), cookie: null as boolean | null, sentinel: null as boolean | null }
    receipts.push(entry)
    const cookie = (await request.allHeaders()).cookie
    entry.cookie = cookie !== undefined
    entry.sentinel = cookie?.split(/;\s*/).some((pair) => pair.startsWith(`${SENTINEL_COOKIE}=`)) ?? false
    await route.continue()
  })
  const stagesOf = (token: string) =>
    receipts
      .filter((r) => r.body.token === token)
      .map((r) => (r.body.reason ? `${r.body.stage}:${r.body.reason}` : r.body.stage))
      .sort()

  const workspaceId = await signInToNewWorkspace(page)
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller), {
      timeout: 15000,
      message: "Production service worker did not take control; run with PLAYWRIGHT_PROD_FRONTEND=1",
    })
    .toBe(true)

  const advertised = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return new Promise<unknown>((resolve) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => resolve((event.data as { pushReceiptVersion?: unknown }).pushReceiptVersion)
      registration.active!.postMessage({ type: "QUERY_STATUS" }, [channel.port2])
    })
  })
  expect(advertised, "the built worker advertises the receipt protocol").toBe(1)

  const worker = await controllingWorker(page, context)
  expect(await worker.evaluate(() => navigator.userAgent), "the worker's own user agent").toMatch(
    device.workerUserAgent
  )

  // Positive control: a credentialed request from the controlling worker to the
  // same route, with an unissued token, must reach the observer with the cookie.
  await context.addCookies([{ name: SENTINEL_COOKIE, value: base64url(randomBytes(12)), url: origin }])
  const controlToken = newToken()
  await worker.evaluate(
    async ({ url, token }) => {
      await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, stage: "received" }),
      })
    },
    { url: `${origin}/api/workspaces/${workspaceId}/push/receipts`, token: controlToken }
  )
  await expect.poll(() => receipts.filter((r) => r.body.token === controlToken).map((r) => r.sentinel)).toEqual([true])

  await installPushLifetimeObserver(worker)
  try {
    await page.goto(`/w/${workspaceId}?settings=notifications`)
    const dialog = page.getByRole("dialog", { name: "Settings" })
    await expect(dialog.getByText("This device is subscribed.", { exact: false })).toBeVisible({ timeout: 20000 })
    const sendTest = dialog.getByRole("button", { name: "Send test" })
    await expect(sendTest).toHaveAccessibleDescription(
      "Devices on a current version of Threa report back to Threa whether they created it. Those reports expire after 24 hours and are only shown here."
    )

    await sendTest.click()
    const thisDevice = dialog.getByRole("listitem").filter({ hasText: "This device" })
    await expect(thisDevice).toContainText("Couldn't reach push service")
    await expect(thisDevice).toContainText("Waiting for device report")

    const token = newToken()
    // A row exists only if the subscribe handshake registered this device as
    // receipt-capable: the backend issues test tokens to no other device.
    runTestSql(
      `DO $$ DECLARE n int; BEGIN
           UPDATE push_receipts SET token_hash = '${createHash("sha256").update(token).digest("hex")}'
           WHERE scope = 'test' AND workspace_id = '${workspaceId}' AND token_hash IS NOT NULL
             AND subscription_id IN (SELECT id FROM push_subscriptions WHERE endpoint = '${endpoint}');
           GET DIAGNOSTICS n = ROW_COUNT;
           IF n <> 1 THEN RAISE EXCEPTION 'expected one issued test receipt for this device, found %', n; END IF;
         END $$`
    )

    const cdp = await context.newCDPSession(page)
    const registrationId = await activeRegistrationId(cdp, origin)
    await deliverPush(cdp, origin, registrationId, { kind: "test", workspaceId }, token)

    // Rendered only for a device the backend expects a report from: token
    // issued, and a provider outcome (here a lost one) that may have delivered.
    await expect(thisDevice).toContainText("Notification created", { timeout: 20000 })
    await expect(thisDevice).toContainText("Couldn't reach push service")
    await thisDevice.scrollIntoViewIfNeeded()
    await test
      .info()
      .attach(`push-receipts-${device.name}`, { body: await page.screenshot(), contentType: "image/png" })
    expect(await notifications(page, "threa-test")).toEqual([
      { title: "Threa test notification", dataKeys: ["kind", "workspaceId"], actions: [] },
    ])
    await expect.poll(() => stagesOf(token)).toEqual(["notification_created", "received"])

    // A grouped message card through the default branch reports the same way,
    // with this platform's button limit.
    const messageToken = newToken()
    const messageStream = "stream_receiptspec"
    await deliverPush(
      cdp,
      origin,
      registrationId,
      {
        workspaceId,
        streamId: messageStream,
        messageId: "msg_receiptspec",
        activityType: "message",
        streamName: "general",
        authorName: "Ada",
        contentPreview: "hello",
      },
      messageToken
    )
    await expect.poll(() => stagesOf(messageToken)).toEqual(["notification_created", "received"])
    const [messageCard] = await notifications(page, messageStream)
    expect(messageCard?.actions).toEqual(device.messageActions)
    expect(messageCard?.dataKeys).not.toContain("receipt")

    // The platform refuses one card: the worker reports that, and nothing is shown.
    const failedToken = newToken()
    const failedStream = "stream_receiptfailed"
    const restoreShow = await failNotificationsTagged(worker, failedStream)
    try {
      await deliverPush(
        cdp,
        origin,
        registrationId,
        {
          workspaceId,
          streamId: failedStream,
          messageId: "msg_receiptfailed",
          activityType: "message",
          streamName: "general",
          authorName: "Ada",
          contentPreview: "refused",
        },
        failedToken
      )
      await drainPushes(worker, [failedStream])
    } catch (error) {
      // A closed worker fails the undo too; that must not replace this error.
      await restoreShow().catch(() => {})
      throw error
    }
    await restoreShow()
    expect({ stages: stagesOf(failedToken), cards: await notifications(page, failedStream) }).toEqual({
      stages: ["creation_failed", "received"],
      cards: [],
    })

    // A push for the stream the focused, recently used page is showing is
    // suppressed for presence, with the app's own presence and route signals.
    const streamResponse = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "channel", slug: `receipts-${generateTestId()}`, visibility: "public" },
    })
    await expectApiOk(streamResponse, "Create channel")
    const { stream } = (await streamResponse.json()) as { stream: { id: string } }
    await page.goto(`/w/${workspaceId}/s/${stream.id}`)
    await page.bringToFront()
    await page.keyboard.press("Shift")
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const res = await (
              await caches.open("threa-presence")
            ).match("https://threa.local/__presence__/last-interaction")
            return res ? Date.now() - Number(await res.text()) : null
          }),
        { message: "the page records its own recent interaction" }
      )
      .toBeLessThan(60_000)
    const presentToken = newToken()
    await deliverPush(
      cdp,
      origin,
      registrationId,
      {
        workspaceId,
        streamId: stream.id,
        messageId: "msg_receiptpresent",
        activityType: "message",
        streamName: "general",
        authorName: "Ada",
        contentPreview: "seen already",
      },
      presentToken
    )
    await drainPushes(worker, [stream.id])
    expect({ stages: stagesOf(presentToken), cards: await notifications(page, stream.id) }).toEqual({
      stages: ["received", "suppressed:presence"],
      cards: [],
    })

    // An old backend's payload: the card still shows and nothing is reported.
    // Draining the event's own lifetime, not a delay, bounds any late report.
    const before = receipts.length
    const legacyStream = "stream_receiptlegacy"
    await deliverPush(cdp, origin, registrationId, {
      workspaceId,
      streamId: legacyStream,
      messageId: "msg_receiptlegacy",
      activityType: "message",
      streamName: "general",
      authorName: "Ada",
      contentPreview: "legacy",
    })
    const retained = await drainPushes(worker, [legacyStream])
    expect(retained[legacyStream], "the legacy push kept its event alive").toBeGreaterThan(0)
    expect(await notifications(page, legacyStream)).toHaveLength(1)

    const pushReports = receipts.filter((r) => r.body.token !== controlToken)
    expect({
      legacyReports: receipts.length - before,
      pushReports: pushReports.length,
      withCookies: pushReports.filter((r) => r.cookie !== false).length,
    }).toEqual({ legacyReports: 0, pushReports: 8, withCookies: 0 })
  } catch (error) {
    await uninstallPushLifetimeObserver(worker).catch(() => {})
    throw error
  }
  await uninstallPushLifetimeObserver(worker)
}
