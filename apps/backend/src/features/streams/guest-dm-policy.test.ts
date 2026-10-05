import { describe, expect, test } from "bun:test"
import { GUEST_DM_POLICIES, type GuestDmPolicy } from "@threahq/types"
import { isGuestDmOpen } from "./guest-dm-policy"

const guest = { guest: true, admin: false }
const member = { guest: false, admin: false }
const admin = { guest: false, admin: true }

describe("isGuestDmOpen", () => {
  test("should open or close a DM by policy and by who the parties are", () => {
    const pairs = {
      memberAdmin: [member, admin],
      guestAdmin: [guest, admin],
      guestMember: [guest, member],
      guestGuest: [guest, guest],
    }
    const outcomes = (policy: GuestDmPolicy) =>
      Object.fromEntries(Object.entries(pairs).map(([name, parties]) => [name, isGuestDmOpen(policy, parties)]))

    expect({
      off: outcomes(GUEST_DM_POLICIES.OFF),
      admins: outcomes(GUEST_DM_POLICIES.ADMINS),
      open: outcomes(GUEST_DM_POLICIES.OPEN),
    }).toEqual({
      off: { memberAdmin: true, guestAdmin: false, guestMember: false, guestGuest: false },
      admins: { memberAdmin: true, guestAdmin: true, guestMember: false, guestGuest: false },
      open: { memberAdmin: true, guestAdmin: true, guestMember: true, guestGuest: true },
    })
  })
})
