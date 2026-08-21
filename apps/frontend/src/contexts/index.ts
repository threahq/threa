export { AccountQueryClientProvider, makeQueryClient } from "./query-client"
export {
  ServicesProvider,
  useServices,
  useWorkspaceService,
  useStreamService,
  useMessageService,
  useConversationService,
  useBoardViewService,
  useActivityService,
  useSavedService,
  useSavedSuggestionsService,
  useScheduledService,
  useLabelService,
  type Services,
  type WorkspaceService,
  type StreamService,
  type MessageService,
  type ConversationService,
  type BoardViewService,
  type ActivityService,
  type SavedService,
  type SavedSuggestionsService,
  type ScheduledService,
  type LabelService,
} from "./services-context"
export {
  SocketProvider,
  useSocket,
  useSocketStatus,
  useSocketConnected,
  useSocketReconnectCount,
  useSocketIsReconnecting,
  type SocketStatus,
} from "./socket-context"
export { PendingMessagesProvider, usePendingMessages } from "./pending-messages-context"
export {
  PanelProvider,
  usePanel,
  isDraftPanel,
  parseDraftPanel,
  createDraftPanelId,
  isConversationPanel,
  parseConversationPanel,
  createConversationPanelId,
} from "./panel-context"
export { QuickSwitcherProvider, useQuickSwitcher } from "./quick-switcher-context"
export { PreferencesProvider, usePreferences, usePreferencesOptional, useResolvedTheme } from "./preferences-context"
export { SettingsProvider, useSettings, useOptionalSettings } from "./settings-context"
export {
  CoordinatedLoadingProvider,
  CoordinatedLoadingGate,
  MainContentGate,
  useCoordinatedLoading,
  useCoordinatedPhase,
  SKELETON_DELAY_MS,
  LOADING_DELAY_MS,
  type CoordinatedPhase,
  type StreamState,
} from "./coordinated-loading-context"
export {
  SidebarProvider,
  useSidebar,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSE_THRESHOLD,
  sidebarWidthCap,
  clampSidebarWidth,
  type UrgencyBlock,
  type CollapseState,
} from "./sidebar-context"
export { TraceProvider, useTrace } from "./trace-context"
export { MediaGalleryProvider, useMediaGallery } from "./media-gallery-context"
export { CodeViewerProvider, useCodeViewerOptional } from "./code-viewer-context"
export {
  DictationCoordinatorProvider,
  useDictationCoordinator,
  setDictationExternalHold,
  isDictationExternalHeld,
} from "./dictation-coordinator-context"
export {
  StreamAgentActivityProvider,
  useAgentActivitySummary,
  usePublishAgentActivitySummary,
  type AgentActivitySummaryEntry,
} from "./stream-agent-activity-context"
