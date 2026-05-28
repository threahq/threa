import { api } from "./client"
import type { CreateLabelInput, Label, LabelMember, UpdateLabelInput } from "@threa/types"

export type { CreateLabelInput, UpdateLabelInput }

export const labelsApi = {
  async list(workspaceId: string): Promise<{ labels: Label[]; memberships: LabelMember[] }> {
    return api.get<{ labels: Label[]; memberships: LabelMember[] }>(`/api/workspaces/${workspaceId}/labels`)
  },

  async create(workspaceId: string, data: CreateLabelInput): Promise<Label> {
    const res = await api.post<{ label: Label }>(`/api/workspaces/${workspaceId}/labels`, data)
    return res.label
  },

  async update(workspaceId: string, labelId: string, data: UpdateLabelInput): Promise<Label> {
    const res = await api.patch<{ label: Label }>(`/api/workspaces/${workspaceId}/labels/${labelId}`, data)
    return res.label
  },

  async delete(workspaceId: string, labelId: string): Promise<void> {
    await api.delete(`/api/workspaces/${workspaceId}/labels/${labelId}`)
  },

  async join(workspaceId: string, labelId: string): Promise<LabelMember> {
    const res = await api.post<{ member: LabelMember }>(`/api/workspaces/${workspaceId}/labels/${labelId}/join`)
    return res.member
  },

  async leave(workspaceId: string, labelId: string): Promise<void> {
    await api.post(`/api/workspaces/${workspaceId}/labels/${labelId}/leave`)
  },

  async promote(workspaceId: string, labelId: string): Promise<Label> {
    const res = await api.post<{ label: Label }>(`/api/workspaces/${workspaceId}/labels/${labelId}/promote`)
    return res.label
  },
}
