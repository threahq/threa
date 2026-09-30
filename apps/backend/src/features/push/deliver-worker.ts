import type { JobHandler, OnDLQHook, PushDeliverJobData, PushSessionExpiredJobData } from "../../lib/queue"
import type { PushService } from "./service"

/** `push.deliver`: one provider attempt per job, owned by the job's queue claim. Throws only on infrastructure failure (INV-34). */
export function createPushDeliverWorker(deps: { pushService: PushService }): JobHandler<PushDeliverJobData> {
  return ({ id, data, claim }) => {
    if (!claim) throw new Error("push.deliver runs only under a queue claim")
    return deps.pushService.attemptDelivery({ id, data, claim })
  }
}

/** `push.deliver` onDLQ: a dead-lettered job must not strand its delivery as pending. */
export function createPushDeliverOnDLQ(deps: { pushService: PushService }): OnDLQHook<PushDeliverJobData> {
  return (querier, job) => deps.pushService.recoverDeadLetteredAttempt(querier, job)
}

/** `push.session_expired`: the one-shot notice to a registration whose session expired. */
export function createPushSessionExpiredWorker(deps: {
  pushService: PushService
}): JobHandler<PushSessionExpiredJobData> {
  return (job) => deps.pushService.deliverSessionExpired(job.data)
}
