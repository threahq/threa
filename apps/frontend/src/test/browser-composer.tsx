import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import type { JSONContent } from "@tiptap/core"
import { DEFAULT_USER_PREFERENCES } from "@threahq/types"
import { AuthProvider } from "@/auth"
import { PreferencesProvider, ServicesProvider, PanelProvider } from "@/contexts"
import { MessageComposer } from "@/components/composer/message-composer"
import { SyncEngine, SyncEngineContext } from "@/sync/sync-engine"
import { SyncStatusStore } from "@/sync/sync-status"
import { workspacesApi, streamsApi } from "@/api"
import { db } from "@/db"
import { seedCacheFromIdb } from "@/stores/workspace-store"
import { getEmojiList } from "../../../backend/src/features/emoji/emoji"
import "@/index.css"

const workspaceId = "ws_synthetic"

function ComposerFixture() {
  const [content, setContent] = useState<JSONContent>({ type: "doc", content: [{ type: "paragraph" }] })
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <main style={{ width: 800, margin: "80px auto" }}>
      <MessageComposer
        content={content}
        onContentChange={setContent}
        pendingAttachments={[]}
        onRemoveAttachment={() => {}}
        fileInputRef={fileInputRef}
        onFileSelect={() => {}}
        onSubmit={() => {}}
        canSubmit={true}
      />
    </main>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const engine = new SyncEngine({
  workspaceId,
  syncStatus: new SyncStatusStore(),
  queryClient,
  workspaceService: workspacesApi,
  streamService: streamsApi,
})
window.addEventListener("pagehide", () => engine.destroy(), { once: true })

async function mountComposer() {
  await db.userPreferences.put({
    ...DEFAULT_USER_PREFERENCES,
    id: workspaceId,
    workspaceId,
    userId: "usr_synthetic",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    _cachedAt: Date.now(),
  })

  await db.workspaceMetadata.put({
    id: workspaceId,
    workspaceId,
    emojis: getEmojiList(),
    emojiWeights: {},
    commands: [],
    _cachedAt: Date.now(),
  })

  await db.workspaces.put({
    id: workspaceId,
    name: "Synthetic Workspace",
    slug: "synthetic",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    _cachedAt: Date.now(),
  })
  await seedCacheFromIdb(workspaceId)

  const root = document.getElementById("root")
  if (!root) throw new Error("Composer fixture root is missing")

  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/w/${workspaceId}`]}>
        <ServicesProvider>
          <SyncEngineContext.Provider value={engine}>
            <PanelProvider>
              <AuthProvider>
                <PreferencesProvider workspaceId={workspaceId}>
                  <Routes>
                    <Route path="/w/:workspaceId" element={<ComposerFixture />} />
                  </Routes>
                </PreferencesProvider>
              </AuthProvider>
            </PanelProvider>
          </SyncEngineContext.Provider>
        </ServicesProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

void mountComposer()
