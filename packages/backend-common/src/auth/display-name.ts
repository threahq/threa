/** Derive a display name from WorkOS identity fields. */
export function displayNameFromWorkos(user: {
  firstName?: string | null
  lastName?: string | null
  email: string
}): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email
}
