import {
  DEFAULT_WORKSPACE_SETTINGS,
  GUEST_DM_POLICIES,
  type GuestDmPolicy,
  type WorkspaceSettings,
} from "@threahq/types"
import type { Querier } from "../../db"
import { WorkspaceSettingsRepository } from "../workspace-settings"
import { findUserIdsWithoutAdmin, findUserIdsWithoutBrowse } from "../workspaces"
import { StreamMemberRepository } from "./member-repository"

const GUEST_DM_POLICY_KEY = "guestDmPolicy" satisfies keyof WorkspaceSettings

function isGuestDmPolicy(value: unknown): value is GuestDmPolicy {
  return (Object.values(GUEST_DM_POLICIES) as unknown[]).includes(value)
}

interface DmParty {
  guest: boolean
  admin: boolean
}

export async function resolveGuestDmPolicy(db: Querier, workspaceId: string): Promise<GuestDmPolicy> {
  const override = await WorkspaceSettingsRepository.findOverride(db, workspaceId, GUEST_DM_POLICY_KEY)
  return isGuestDmPolicy(override?.value) ? override.value : DEFAULT_WORKSPACE_SETTINGS.guestDmPolicy
}

/** A DM with no guest party is always open; otherwise the policy decides, and `admins` needs every other party of each guest to be an admin. */
export function isGuestDmOpen(policy: GuestDmPolicy, parties: readonly DmParty[]): boolean {
  if (!parties.some((party) => party.guest) || policy === GUEST_DM_POLICIES.OPEN) return true
  if (policy === GUEST_DM_POLICIES.OFF) return false
  return parties.every((party, index) => !party.guest || parties.every((other, i) => i === index || other.admin))
}

/** Null when nobody among `userIds` is a guest or the policy is open: nothing can be closed, so no further lookups. */
async function loadPolicyFacts(db: Querier, workspaceId: string, userIds: readonly string[]) {
  const guestIds = await findUserIdsWithoutBrowse(db, workspaceId, userIds)
  if (guestIds.size === 0) return null
  const policy = await resolveGuestDmPolicy(db, workspaceId)
  if (policy === GUEST_DM_POLICIES.OPEN) return null
  const nonAdminIds =
    policy === GUEST_DM_POLICIES.ADMINS ? await findUserIdsWithoutAdmin(db, workspaceId, userIds) : new Set<string>()
  return {
    policy,
    party: (userId: string): DmParty => ({ guest: guestIds.has(userId), admin: !nonAdminIds.has(userId) }),
  }
}

/** The ids among `dmStreamIds` that the guest DM policy currently closes to every writer. */
export async function findGuestPolicyClosedDmIds(
  db: Querier,
  workspaceId: string,
  dmStreamIds: readonly string[]
): Promise<Set<string>> {
  if (dmStreamIds.length === 0) return new Set()
  const members = await StreamMemberRepository.list(db, workspaceId, { streamIds: [...new Set(dmStreamIds)] })
  const facts = await loadPolicyFacts(db, workspaceId, [...new Set(members.map((member) => member.memberId))])
  if (!facts) return new Set()
  const partiesByDm = new Map<string, DmParty[]>()
  for (const member of members) {
    const parties = partiesByDm.get(member.streamId) ?? []
    parties.push(facts.party(member.memberId))
    partiesByDm.set(member.streamId, parties)
  }
  return new Set([...partiesByDm].filter(([, parties]) => !isGuestDmOpen(facts.policy, parties)).map(([id]) => id))
}

/** Whether a DM between `userIds` may exist, for a pair that has no stream yet. */
export async function isGuestDmOpenForUsers(
  db: Querier,
  workspaceId: string,
  userIds: readonly string[]
): Promise<boolean> {
  const facts = await loadPolicyFacts(db, workspaceId, userIds)
  return !facts || isGuestDmOpen(facts.policy, userIds.map(facts.party))
}
