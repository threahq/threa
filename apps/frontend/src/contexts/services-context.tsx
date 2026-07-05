import { createContext, useContext, useMemo, type ReactNode } from "react"
import {
  workspacesApi,
  streamsApi,
  messagesApi,
  conversationsApi,
  activityApi,
  savedApi,
  savedSuggestionsApi,
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
  pauseNotifications: typeof workspacesApi.pauseNotifications
  resumeNotifications: typeof workspacesApi.resumeNotifications
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
  updateToolPolicy: typeof streamsApi.updateToolPolicy
  archive: typeof streamsApi.archive
  unarchive: typeof streamsApi.unarchive
  getEvents: typeof streamsApi.getEvents
  getEventsAround: typeof streamsApi.getEventsAround
  getEventsAroundDate: typeof streamsApi.getEventsAroundDate
  markAsRead: typeof streamsApi.markAsRead
  markUnread: typeof streamsApi.markUnread
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
  listByWorkspace: typeof conversationsApi.listByWorkspace
  listByStream: typeof conversationsApi.listByStream
  getById: typeof conversationsApi.getById
  getMessages: typeof conversationsApi.getMessages
  getBoardMessages: typeof conversationsApi.getBoardMessages
  getBoardPost: typeof conversationsApi.getBoardPost
  markRead: typeof conversationsApi.markRead
  markUnread: typeof conversationsApi.markUnread
  reassignMessage: typeof conversationsApi.reassignMessage
  updateConversation: typeof conversationsApi.updateConversation
  hideConversation: typeof conversationsApi.hideConversation
  unhideConversation: typeof conversationsApi.unhideConversation
  muteStream: typeof conversationsApi.muteStream
  unmuteStream: typeof conversationsApi.unmuteStream
  getBoardExclusions: typeof conversationsApi.getBoardExclusions
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

export interface SavedSuggestionsService {
  list: typeof savedSuggestionsApi.list
  accept: typeof savedSuggestionsApi.accept
  dismiss: typeof savedSuggestionsApi.dismiss
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
  listMessages: typeof labelsApi.listMessages
  create: typeof labelsApi.create
  update: typeof labelsApi.update
  delete: typeof labelsApi.delete
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
  savedSuggestions: SavedSuggestionsService
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
      savedSuggestions: overrides?.savedSuggestions ?? savedSuggestionsApi,
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

export function useSavedSuggestionsService(): SavedSuggestionsService {
  return useServices().savedSuggestions
}

export function useScheduledService(): ScheduledService {
  return useServices().scheduled
}

export function useLabelService(): LabelService {
  return useServices().labels
}
