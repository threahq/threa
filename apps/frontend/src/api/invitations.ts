import { api } from "./client"
import type {
  WorkspaceInvitation,
  SendInvitationsInput,
  SendInvitationsResponse,
  CreateInvitationLinkInput,
  CreateInvitationLinkResponse,
  UpdateInvitationLinkInput,
  UpdateInvitationLinkResponse,
  InvitationLinkLookupResponse,
  ClaimInvitationLinkInput,
  ClaimInvitationLinkResponse,
} from "@threa/types"

export const INVITATION_ERROR_CODES = {
  NOT_FOUND: "INVITATION_NOT_FOUND",
  REVOKED: "INVITATION_REVOKED",
  EXPIRED: "INVITATION_EXPIRED",
  EXHAUSTED: "INVITATION_EXHAUSTED",
  ALREADY_CLAIMED: "INVITATION_ALREADY_CLAIMED",
  EMAIL_MISMATCH: "INVITATION_EMAIL_MISMATCH",
  CLAIM_LIMIT: "INVITATION_CLAIM_LIMIT",
  ROLLOUT_UNAVAILABLE: "INVITATION_ROLLOUT_UNAVAILABLE",
} as const

export type InvitationErrorCode = (typeof INVITATION_ERROR_CODES)[keyof typeof INVITATION_ERROR_CODES]

export function isInvitationErrorCode(code: string): code is InvitationErrorCode {
  return Object.values(INVITATION_ERROR_CODES).some((value) => value === code)
}

export const invitationKeys = {
  all: ["invitations"] as const,
  /** The pending-invitations list for one workspace — the invalidation target
   *  when an `invitation:*` event lands (workspace-sync). */
  list: (workspaceId: string) => [...invitationKeys.all, workspaceId] as const,
}

export const invitationsApi = {
  async list(workspaceId: string): Promise<WorkspaceInvitation[]> {
    const res = await api.get<{ invitations: WorkspaceInvitation[] }>(`/api/workspaces/${workspaceId}/invitations`)
    return res.invitations
  },

  async send(workspaceId: string, data: SendInvitationsInput): Promise<SendInvitationsResponse> {
    return api.post<SendInvitationsResponse>(`/api/workspaces/${workspaceId}/invitations`, data)
  },

  async createLink(workspaceId: string, data: CreateInvitationLinkInput): Promise<CreateInvitationLinkResponse> {
    return api.post<CreateInvitationLinkResponse>(`/api/workspaces/${workspaceId}/invitations/links`, data)
  },

  async updateLink(
    workspaceId: string,
    invitationId: string,
    data: UpdateInvitationLinkInput
  ): Promise<UpdateInvitationLinkResponse> {
    return api.patch<UpdateInvitationLinkResponse>(`/api/workspaces/${workspaceId}/invitations/${invitationId}`, data)
  },

  async revoke(workspaceId: string, invitationId: string): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/invitations/${invitationId}/revoke`)
  },

  async resend(workspaceId: string, invitationId: string): Promise<WorkspaceInvitation> {
    const res = await api.post<{ invitation: WorkspaceInvitation }>(
      `/api/workspaces/${workspaceId}/invitations/${invitationId}/resend`
    )
    return res.invitation
  },

  /** Public/unauthenticated: look up a /join token's workspace metadata. */
  async lookupLink(token: string): Promise<InvitationLinkLookupResponse> {
    return api.get<InvitationLinkLookupResponse>(`/api/invitations/lookup?token=${encodeURIComponent(token)}`)
  },

  /** Public/unauthenticated: submit an email to claim a /join link. */
  async claimLink(data: ClaimInvitationLinkInput): Promise<ClaimInvitationLinkResponse> {
    return api.post<ClaimInvitationLinkResponse>(`/api/invitations/claim`, data)
  },
}
