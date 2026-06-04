import { createContext, useContext, useMemo, type ReactNode } from "react"
import {
  workspacesApi,
  streamsApi,
  messagesApi,
  conversationsApi,
  activityApi,
  savedApi,
  scheduledApi,
  labelsApi,
} from "@/api"

// Service interfaces - components depend on these, not implementations
export interface WorkspaceService {
  list: typeof workspacesApi.list
  listRegions: typeof workspacesApi.listRegions
  get: typeof workspacesApi.get
  bootstrap: typeof workspacesApi.bootstrap
  create: typeof workspacesApi.create
  markAllAsRead: typeof workspacesApi.markAllAsRead
  acceptInvitation: typeof workspacesApi.acceptInvitation
  updateProfile: typeof workspacesApi.updateProfile
  setStatus: typeof workspacesApi.setStatus
  clearStatus: typeof workspacesApi.clearStatus
  uploadAvatar: typeof workspacesApi.uploadAvatar
  removeAvatar: typeof workspacesApi.removeAvatar
}

export interface StreamService {
  list: typeof streamsApi.list
  get: typeof streamsApi.get
  bootstrap: typeof streamsApi.bootstrap
  create: typeof streamsApi.create
  update: typeof streamsApi.update
  updateCompanionMode: typeof streamsApi.updateCompanionMode
  archive: typeof streamsApi.archive
  unarchive: typeof streamsApi.unarchive
  getEvents: typeof streamsApi.getEvents
  getEventsAround: typeof streamsApi.getEventsAround
  markAsRead: typeof streamsApi.markAsRead
  checkSlugAvailable: typeof streamsApi.checkSlugAvailable
  setNotificationLevel: typeof streamsApi.setNotificationLevel
  addMember: typeof streamsApi.addMember
  removeMember: typeof streamsApi.removeMember
}

export interface MessageService {
  create: typeof messagesApi.create
  createDm: typeof messagesApi.createDm
  update: typeof messagesApi.update
  delete: typeof messagesApi.delete
  validateMoveToThread: typeof messagesApi.validateMoveToThread
  moveToThread: typeof messagesApi.moveToThread
  addReaction: typeof messagesApi.addReaction
  removeReaction: typeof messagesApi.removeReaction
  getVersions: typeof messagesApi.getVersions
}

export interface ConversationService {
  listByStream: typeof conversationsApi.listByStream
  getById: typeof conversationsApi.getById
  getMessages: typeof conversationsApi.getMessages
}

export interface ActivityService {
  list: typeof activityApi.list
  markAsRead: typeof activityApi.markAsRead
  markAllAsRead: typeof activityApi.markAllAsRead
}

export interface SavedService {
  list: typeof savedApi.list
  create: typeof savedApi.create
  update: typeof savedApi.update
  delete: typeof savedApi.delete
}

export interface ScheduledService {
  list: typeof scheduledApi.list
  getById: typeof scheduledApi.getById
  create: typeof scheduledApi.create
  update: typeof scheduledApi.update
  delete: typeof scheduledApi.delete
  lockForEdit: typeof scheduledApi.lockForEdit
  releaseEditLock: typeof scheduledApi.releaseEditLock
  sendNow: typeof scheduledApi.sendNow
}

export interface LabelService {
  list: typeof labelsApi.list
  create: typeof labelsApi.create
  update: typeof labelsApi.update
  delete: typeof labelsApi.delete
  join: typeof labelsApi.join
  leave: typeof labelsApi.leave
  promote: typeof labelsApi.promote
  assign: typeof labelsApi.assign
  unassign: typeof labelsApi.unassign
}

export interface Services {
  workspaces: WorkspaceService
  streams: StreamService
  messages: MessageService
  conversations: ConversationService
  activity: ActivityService
  saved: SavedService
  scheduled: ScheduledService
  labels: LabelService
}

const ServicesContext = createContext<Services | null>(null)

interface ServicesProviderProps {
  children: ReactNode
  // Allow overriding services for testing
  services?: Partial<Services>
}

export function ServicesProvider({ children, services: overrides }: ServicesProviderProps) {
  const services = useMemo<Services>(
    () => ({
      workspaces: overrides?.workspaces ?? workspacesApi,
      streams: overrides?.streams ?? streamsApi,
      messages: overrides?.messages ?? messagesApi,
      conversations: overrides?.conversations ?? conversationsApi,
      activity: overrides?.activity ?? activityApi,
      saved: overrides?.saved ?? savedApi,
      scheduled: overrides?.scheduled ?? scheduledApi,
      labels: overrides?.labels ?? labelsApi,
    }),
    [overrides]
  )

  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
}

export function useServices(): Services {
  const services = useContext(ServicesContext)
  if (!services) {
    throw new Error("useServices must be used within a ServicesProvider")
  }
  return services
}

// Convenience hooks for individual services
export function useWorkspaceService(): WorkspaceService {
  return useServices().workspaces
}

export function useStreamService(): StreamService {
  return useServices().streams
}

export function useMessageService(): MessageService {
  return useServices().messages
}

export function useConversationService(): ConversationService {
  return useServices().conversations
}

export function useActivityService(): ActivityService {
  return useServices().activity
}

export function useSavedService(): SavedService {
  return useServices().saved
}

export function useScheduledService(): ScheduledService {
  return useServices().scheduled
}

export function useLabelService(): LabelService {
  return useServices().labels
}
