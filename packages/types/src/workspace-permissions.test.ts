import { describe, test, expect } from "bun:test"
import {
  WORKSPACE_PERMISSION_SCOPES,
  WORKSPACE_PERMISSIONS,
  WORKSPACE_ROLE_DEFINITIONS,
  WORKSPACE_ROLE_SLUGS,
  parseJwtPermissions,
  permissionsForRole,
  rolesGrant,
} from "./workspace-permissions"

const SCOPE_VALUES = new Set<string>(Object.values(WORKSPACE_PERMISSION_SCOPES))

function getRole(slug: string) {
  const role = WORKSPACE_ROLE_DEFINITIONS.find((r) => r.slug === slug)
  if (!role) throw new Error(`Role ${slug} not found`)
  return role
}

describe("WORKSPACE_PERMISSIONS catalog", () => {
  test("every role permission references a known scope", () => {
    for (const role of WORKSPACE_ROLE_DEFINITIONS) {
      for (const slug of role.permissions) {
        expect(SCOPE_VALUES.has(slug)).toBe(true)
      }
    }
  })

  test("WORKSPACE_PERMISSIONS exposes one entry per scope, no duplicates", () => {
    const slugs = WORKSPACE_PERMISSIONS.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(slugs.length).toBe(SCOPE_VALUES.size)
    for (const slug of slugs) {
      expect(SCOPE_VALUES.has(slug)).toBe(true)
    }
  })

  test("catalog has exactly 23 permissions", () => {
    expect(WORKSPACE_PERMISSIONS).toHaveLength(23)
    expect(SCOPE_VALUES.size).toBe(23)
  })
})

describe("WORKSPACE_ROLE_DEFINITIONS", () => {
  test("contains exactly member, admin, owner", () => {
    const slugs = new Set(WORKSPACE_ROLE_DEFINITIONS.map((r) => r.slug))
    expect(slugs).toEqual(
      new Set([WORKSPACE_ROLE_SLUGS.MEMBER, WORKSPACE_ROLE_SLUGS.ADMIN, WORKSPACE_ROLE_SLUGS.OWNER])
    )
  })

  test("owner ⊇ admin ⊇ member", () => {
    const owner = new Set(getRole(WORKSPACE_ROLE_SLUGS.OWNER).permissions)
    const admin = new Set(getRole(WORKSPACE_ROLE_SLUGS.ADMIN).permissions)
    const member = new Set(getRole(WORKSPACE_ROLE_SLUGS.MEMBER).permissions)

    for (const slug of member) expect(admin.has(slug)).toBe(true)
    for (const slug of admin) expect(owner.has(slug)).toBe(true)
  })

  test("member has self-serve writes but not admin powers", () => {
    const member = getRole(WORKSPACE_ROLE_SLUGS.MEMBER)
    const slugs = new Set(member.permissions)

    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_PERSONAL)).toBe(true)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_WRITE)).toBe(true)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE)).toBe(true)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.LABELS_READ)).toBe(true)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE)).toBe(true)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_READ)).toBe(true)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_WRITE)).toBe(true)

    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_SHARED)).toBe(false)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE)).toBe(false)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)).toBe(false)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)).toBe(false)
    expect(slugs.has(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)).toBe(false)
  })

  test("admin holds all three bot scopes plus member-management", () => {
    const admin = new Set(getRole(WORKSPACE_ROLE_SLUGS.ADMIN).permissions)

    expect(admin.has(WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_PERSONAL)).toBe(true)
    expect(admin.has(WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_SHARED)).toBe(true)
    expect(admin.has(WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE)).toBe(true)
    expect(admin.has(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)).toBe(true)
    expect(admin.has(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)).toBe(true)

    expect(admin.has(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)).toBe(false)
  })

  test("only owner holds workspace:owner", () => {
    for (const role of WORKSPACE_ROLE_DEFINITIONS) {
      const has = role.permissions.includes(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)
      expect(has).toBe(role.slug === WORKSPACE_ROLE_SLUGS.OWNER)
    }
  })

  test("absolute permission counts (member=14, admin=22, owner=23)", () => {
    expect(getRole(WORKSPACE_ROLE_SLUGS.MEMBER).permissions).toHaveLength(14)
    expect(getRole(WORKSPACE_ROLE_SLUGS.ADMIN).permissions).toHaveLength(22)
    expect(getRole(WORKSPACE_ROLE_SLUGS.OWNER).permissions).toHaveLength(23)
  })
})

describe("permissionsForRole", () => {
  test("returns a fresh array (callers cannot mutate the catalog)", () => {
    const a = permissionsForRole(WORKSPACE_ROLE_SLUGS.MEMBER)
    a.push(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)
    const b = permissionsForRole(WORKSPACE_ROLE_SLUGS.MEMBER)
    expect(b).not.toContain(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)
  })

  test("throws on unknown slug", () => {
    expect(() => permissionsForRole("ghost" as never)).toThrow(/Unknown workspace role/)
  })
})

describe("rolesGrant", () => {
  test("true when any role in the list grants the permission", () => {
    expect(rolesGrant([WORKSPACE_ROLE_SLUGS.ADMIN], WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)).toBe(true)
    expect(rolesGrant([WORKSPACE_ROLE_SLUGS.OWNER], WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)).toBe(true)
    expect(
      rolesGrant([WORKSPACE_ROLE_SLUGS.MEMBER, WORKSPACE_ROLE_SLUGS.ADMIN], WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)
    ).toBe(true)
  })

  test("false when no listed role grants the permission", () => {
    expect(rolesGrant([WORKSPACE_ROLE_SLUGS.MEMBER], WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)).toBe(false)
    expect(rolesGrant([WORKSPACE_ROLE_SLUGS.ADMIN], WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER)).toBe(false)
    expect(rolesGrant([], WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)).toBe(false)
  })

  test("ignores unknown role slugs (forward-compat with WorkOS roles we don't model)", () => {
    expect(rolesGrant(["unknown:role"], WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)).toBe(false)
    expect(rolesGrant(["unknown:role", WORKSPACE_ROLE_SLUGS.ADMIN], WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)).toBe(
      true
    )
  })
})

describe("parseJwtPermissions", () => {
  test("returns an empty array for empty input", () => {
    expect(parseJwtPermissions([])).toEqual([])
  })

  test("preserves catalog slugs in their original order", () => {
    const input = [
      WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
      WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE,
      WORKSPACE_PERMISSION_SCOPES.WORKSPACE_OWNER,
    ]
    expect(parseJwtPermissions(input)).toEqual(input)
  })

  test("drops unknown slugs without throwing (forward-compat with WorkOS rollout drift)", () => {
    const input = [
      WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
      "future:permission",
      WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE,
      "",
    ]
    expect(parseJwtPermissions(input)).toEqual([
      WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
      WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE,
    ])
  })
})
