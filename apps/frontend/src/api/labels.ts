import { api } from "./client"
import type {
  CreateLabelInput,
  Label,
  LabelAssignment,
  LabelableResourceType,
  LabeledMessage,
  UpdateLabelInput,
} from "@threahq/types"

export type { CreateLabelInput, UpdateLabelInput }

export interface ResourceRef {
  resourceType: LabelableResourceType
  resourceId: string
}

export const labelsApi = {
  async list(workspaceId: string): Promise<{ labels: Label[]; assignments: LabelAssignment[] }> {
    return api.get<{ labels: Label[]; assignments: LabelAssignment[] }>(`/api/workspaces/${workspaceId}/labels`)
  },

  async listMessages(workspaceId: string, labelId: string): Promise<LabeledMessage[]> {
    const res = await api.get<{ messages: LabeledMessage[] }>(
      `/api/workspaces/${workspaceId}/labels/${labelId}/messages`
    )
    return res.messages
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

  async assign(workspaceId: string, labelId: string, resource: ResourceRef): Promise<LabelAssignment> {
    const res = await api.post<{ assignment: LabelAssignment }>(
      `/api/workspaces/${workspaceId}/labels/${labelId}/assignments`,
      resource
    )
    return res.assignment
  },

  async unassign(workspaceId: string, labelId: string, resource: ResourceRef): Promise<void> {
    await api.delete(`/api/workspaces/${workspaceId}/labels/${labelId}/assignments`, {
      body: JSON.stringify(resource),
    })
  },
}
