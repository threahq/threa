import { StrictMode, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router-dom"
import type { Editor, JSONContent } from "@tiptap/core"
import * as Y from "yjs"
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror"
import { applyAwarenessUpdate, Awareness } from "y-protocols/awareness"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import {
  DOC_FRAGMENT,
  type DocAwarenessPayload,
  type DocState,
  type DocUpdatedPayload,
  type Stream,
} from "@threahq/types"
import { toast } from "sonner"
import { ApiError } from "@/api/client"
import { docsApi } from "@/api/docs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { RevealOnReady } from "@/contexts/coordinated-loading-context"
import { MediaGalleryProvider } from "@/contexts/media-gallery-context"
import { __resetOverlayHistoryForTests, attachOverlayHistoryRouter } from "@/components/ui/history-back-close"
import * as mobileModule from "@/hooks/use-mobile"
import * as inputModeModule from "@/hooks/use-input-mode"
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh"
import { DocSync, FLUSH_CAP_MS } from "@/lib/docs/doc-sync"
import { PRESENCE_SEND_WINDOW_MS } from "@/lib/docs/doc-presence"
import { getOpenDocIds } from "@/lib/docs/open-docs"
import { requestBlockFocus, takeBlockFocus } from "@/lib/docs/block-focus"
import { getPresenceColor } from "@/lib/avatar-color"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as renameModule from "@/hooks/use-rename-stream"
import * as regenerateModule from "@/hooks/use-regenerate-title"
import * as attachmentsModule from "@/hooks/use-attachments"
import { attachmentsApi } from "@/api"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceEmojiModule from "@/hooks/use-workspace-emoji"
import * as socketRoomModule from "@/lib/socket-room"
import * as operationQueueModule from "@/sync/operation-queue"
import * as syncEngineModule from "@/sync/sync-engine"
import { SocketEventGate } from "@/sync/socket-event-gate"
import * as triggersModule from "@/components/editor/triggers"
import { DocPaneBody } from "./doc-pane-body"
import { useDocSync } from "./use-doc-sync"
import { BLOCK_HIGHLIGHT_MS } from "@/components/editor/doc-block-landing-extension"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"

function paragraphs(...texts: string[]): JSONContent {
  return { type: "doc", content: texts.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) }
}

function docState(ydoc: Y.Doc, seq: number): DocState {
  return { stream: { id: DOC_ID } as Stream, seq, state: bytesToBase64(Y.encodeStateAsUpdate(ydoc)), sections: [] }
}

function proseMirror(): HTMLElement & { editor: Editor } {
  const element = document.querySelector(".ProseMirror")
  if (!element) throw new Error("editor not mounted")
  return element as HTMLElement & { editor: Editor }
}

/** tiptap's focus command lands on the next animation frame. */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

function PullToRefreshHost({ children }: { children: ReactNode }) {
  const { ref, distance } = usePullToRefresh({ enabled: true })
  return (
    <div ref={ref} data-testid="pull-host" data-distance={distance}>
      {children}
    </div>
  )
}

const IMAGE_DOC: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Rotation tracker" }] },
    {
      type: "paragraph",
      content: [
        {
          type: "attachmentReference",
          attrs: {
            id: "attach_shot",
            filename: "shot.png",
            mimeType: "image/png",
            sizeBytes: 3,
            status: "uploaded",
            display: "inline",
          },
        },
      ],
    },
  ],
}

function DocPane({ canWrite }: { canWrite: boolean | null }) {
  const view = useDocSync(WORKSPACE_ID, DOC_ID)
  return <DocPaneBody workspaceId={WORKSPACE_ID} docId={DOC_ID} canWrite={canWrite} view={view} />
}

describe("DocPaneBody", () => {
  let gate: SocketEventGate
  let serverDoc: Y.Doc
  let queryClient: QueryClient
  let joinRoom: MockInstance<typeof socketRoomModule.joinRoomWithAck>
  let kickOperationQueue: ReturnType<typeof vi.fn>
  let socket: { on: MockInstance; off: MockInstance; emit: MockInstance; connected: boolean }

  beforeEach(() => {
    vi.spyOn(contextsModule, "usePanel").mockReturnValue({
      getPanelUrl: (panelId: string) => `/w/${WORKSPACE_ID}?panel=${panelId}`,
    } as unknown as ReturnType<typeof contextsModule.usePanel>)
    serverDoc = prosemirrorJSONToYDoc(getThreaSchema(), paragraphs("Rotation tracker"), DOC_FRAGMENT)
    gate = new SocketEventGate(WORKSPACE_ID)
    socket = { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: true }
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(
      socket as unknown as ReturnType<typeof contextsModule.useSocket>
    )
    vi.spyOn(contextsModule, "useSocketReconnectCount").mockReturnValue(0)
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { keyboardShortcuts: {} },
      isLoading: false,
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(renameModule, "useRenameStream").mockReturnValue({
      rename: vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
      canRename: true,
      isPending: false,
      error: null,
    })
    vi.spyOn(regenerateModule, "useRegenerateTitle").mockReturnValue({
      regenerate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      isPending: false,
      error: null,
    })
    vi.spyOn(hooksModule, "useCurrentWorkspaceUser").mockReturnValue({
      id: "usr_viewer",
      name: "Viewer",
    } as unknown as ReturnType<typeof hooksModule.useCurrentWorkspaceUser>)
    joinRoom = vi.spyOn(socketRoomModule, "joinRoomWithAck").mockResolvedValue(undefined)
    kickOperationQueue = vi.fn()
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      getLiveEventSource: () => gate,
      backfillStreamGap: vi.fn(),
      kickOperationQueue,
    } as unknown as ReturnType<typeof syncEngineModule.useOptionalSyncEngine>)
    vi.spyOn(mentionablesModule, "useMentionables").mockReturnValue({
      mentionables: [],
    } as unknown as ReturnType<typeof mentionablesModule.useMentionables>)
    vi.spyOn(workspaceEmojiModule, "useWorkspaceEmoji").mockReturnValue({
      emojis: [],
      emojiWeights: new Map(),
      toEmoji: () => null,
    } as unknown as ReturnType<typeof workspaceEmojiModule.useWorkspaceEmoji>)
    vi.spyOn(triggersModule, "useMentionSuggestion").mockReturnValue({
      suggestionConfig: null,
      renderMentionList: () => null,
    } as unknown as ReturnType<typeof triggersModule.useMentionSuggestion>)
    vi.spyOn(triggersModule, "useChannelSuggestion").mockReturnValue({
      suggestionConfig: null,
      renderChannelList: () => null,
    } as unknown as ReturnType<typeof triggersModule.useChannelSuggestion>)
    vi.spyOn(triggersModule, "useEmojiSuggestion").mockReturnValue({
      suggestionConfig: null,
      renderEmojiGrid: () => null,
    } as unknown as ReturnType<typeof triggersModule.useEmojiSuggestion>)
    vi.spyOn(docsApi, "get").mockImplementation(async () => docState(serverDoc, 1))
    vi.spyOn(docsApi, "listUpdates").mockResolvedValue({ updates: [] })
    vi.spyOn(docsApi, "listThreads").mockResolvedValue({ threads: [] })
    vi.spyOn(docsApi, "listBacklinks").mockResolvedValue({ backlinks: [] })
    vi.spyOn(docsApi, "postUpdate").mockResolvedValue({ seq: 2, applied: true, touchedBlockIds: [] })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function tree(canWrite: boolean | null, wrap: (body: ReactNode) => ReactNode = (body) => body) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}`]}>
            <MediaGalleryProvider>
              <Routes>
                <Route path="/w/:workspaceId" element={wrap(<DocPane canWrite={canWrite} />)} />
              </Routes>
            </MediaGalleryProvider>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    )
  }

  function mount(
    canWrite: boolean | null = true,
    { strict = false, wrap }: { strict?: boolean; wrap?: (body: ReactNode) => ReactNode } = {}
  ) {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(strict ? <StrictMode>{tree(canWrite, wrap)}</StrictMode> : tree(canWrite, wrap))
    return {
      ...view,
      rerender: (next: boolean | null) =>
        view.rerender(strict ? <StrictMode>{tree(next, wrap)}</StrictMode> : tree(next, wrap)),
    }
  }

  /** Mounts and waits until the editor shows the loaded doc. */
  async function mountLoaded(...args: Parameters<typeof mount>) {
    const view = mount(...args)
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    return view
  }

  function remoteParagraph(text: string, seq: number): DocUpdatedPayload {
    const before = Y.encodeStateVector(serverDoc)
    const paragraph = new Y.XmlElement("paragraph")
    paragraph.insert(0, [new Y.XmlText(text)])
    serverDoc.getXmlFragment(DOC_FRAGMENT).push([paragraph])
    return {
      workspaceId: WORKSPACE_ID,
      streamId: DOC_ID,
      seq,
      update: bytesToBase64(Y.encodeStateAsUpdate(serverDoc, before)),
      touchedBlockIds: [],
      actorId: "usr_other",
      actorType: "user",
    }
  }

  /** The awareness frames the viewer has sent to this doc's room so far. */
  function awarenessFrames(): DocAwarenessPayload[] {
    return socket.emit.mock.calls
      .filter(([event, payload]) => event === "doc:awareness" && (payload as DocAwarenessPayload).docId === DOC_ID)
      .map(([, payload]) => payload as DocAwarenessPayload)
  }

  /** The users a peer in the doc room would see after applying the given frames. */
  function usersSeenByPeer(frames = awarenessFrames()): unknown[] {
    const peer = new Awareness(new Y.Doc())
    try {
      for (const frame of frames) applyAwarenessUpdate(peer, base64ToBytes(frame.update), "test")
      return [...peer.getStates().entries()]
        .filter(([clientId]) => clientId !== peer.clientID)
        .map(([, state]) => state.user)
    } finally {
      peer.destroy()
    }
  }

  /** What a peer sees of the viewer: the colour comes from the viewer's id. */
  const VIEWER_PRESENCE = { userId: "usr_viewer", name: "Viewer", color: getPresenceColor("usr_viewer") }

  it("renders the loaded doc in an editable editor with the formatting toolbar", async () => {
    await mountLoaded()
    expect({
      editable: proseMirror().getAttribute("contenteditable"),
      toolbar: screen.queryByRole("button", { name: "Bold" }) !== null,
    }).toEqual({ editable: "true", toolbar: true })
  })

  it("posts a local edit once it ends a word", async () => {
    await mountLoaded()

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" for March ").run()
    })

    await waitFor(() => expect(docsApi.postUpdate).toHaveBeenCalledTimes(1), { timeout: 2000 })
    const posted = new Y.Doc()
    Y.applyUpdate(posted, Y.encodeStateAsUpdate(serverDoc))
    const [workspaceId, docId, update] = vi.mocked(docsApi.postUpdate).mock.calls[0]
    Y.applyUpdate(posted, base64ToBytes(update))
    expect({ workspaceId, docId, text: posted.getXmlFragment(DOC_FRAGMENT).toString() }).toEqual({
      workspaceId: WORKSPACE_ID,
      docId: DOC_ID,
      text: expect.stringContaining("Rotation tracker for March"),
    })
  })

  it("should save unsent edits when the editor loses focus", async () => {
    await mountLoaded()

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" draft").run()
    })
    fireEvent.blur(proseMirror())

    await waitFor(() => expect(docsApi.postUpdate).toHaveBeenCalledTimes(1), { timeout: FLUSH_CAP_MS - 200 })
    const posted = new Y.Doc()
    Y.applyUpdate(posted, Y.encodeStateAsUpdate(serverDoc))
    Y.applyUpdate(posted, base64ToBytes(vi.mocked(docsApi.postUpdate).mock.calls[0][2]))
    expect(posted.getXmlFragment(DOC_FRAGMENT).toString()).toContain("Rotation tracker draft")
  })

  it("should queue unsent edits when the page hides", async () => {
    const enqueue = vi.spyOn(operationQueueModule, "enqueueDocUpdate").mockResolvedValue()
    await mountLoaded()

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" draft").run()
    })
    window.dispatchEvent(new Event("pagehide"))

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1))
    const queued = new Y.Doc()
    Y.applyUpdate(queued, Y.encodeStateAsUpdate(serverDoc))
    Y.applyUpdate(queued, base64ToBytes(enqueue.mock.calls[0]![2]))
    expect({
      queued: queued.getXmlFragment(DOC_FRAGMENT).toString(),
      posts: vi.mocked(docsApi.postUpdate).mock.calls.length,
    }).toEqual({ queued: expect.stringContaining("Rotation tracker draft"), posts: 0 })
  })

  it("should queue unsent edits when the page goes to the background", async () => {
    const enqueue = vi.spyOn(operationQueueModule, "enqueueDocUpdate").mockResolvedValue()
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    await mountLoaded()

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" draft").run()
    })
    document.dispatchEvent(new Event("visibilitychange"))
    visibility.mockRestore()

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1))
    const queued = new Y.Doc()
    Y.applyUpdate(queued, Y.encodeStateAsUpdate(serverDoc))
    Y.applyUpdate(queued, base64ToBytes(enqueue.mock.calls[0]![2]))
    expect(queued.getXmlFragment(DOC_FRAGMENT).toString()).toContain("Rotation tracker draft")
  })

  it("should fetch missed edits when the browser comes back online", async () => {
    await mountLoaded()
    await waitFor(() => expect(docsApi.listUpdates).toHaveBeenCalledTimes(1))

    window.dispatchEvent(new Event("online"))

    await waitFor(() => expect(docsApi.listUpdates).toHaveBeenCalledTimes(2))
  })

  it("should send unsent edits when the browser comes back online", async () => {
    await mountLoaded()

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" draft").run()
    })
    window.dispatchEvent(new Event("online"))

    await waitFor(() => expect(docsApi.postUpdate).toHaveBeenCalledTimes(1), { timeout: FLUSH_CAP_MS - 200 })
  })

  it("shows a remote update delivered through the live event source", async () => {
    await mountLoaded()
    await waitFor(() => expect(docsApi.listUpdates).toHaveBeenCalledTimes(1))

    const payload = remoteParagraph("Second shift", 2)
    await act(() => gate.dispatch("doc:updated", payload))

    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation trackerSecond shift"))
    expect(docsApi.listUpdates).toHaveBeenCalledTimes(1)
  })

  it("gives a read-only viewer no toolbar and a non-editable editor", async () => {
    await mountLoaded(false)
    expect({
      editable: proseMirror().getAttribute("contenteditable"),
      toolbar: screen.queryByRole("button", { name: "Bold" }) !== null,
    }).toEqual({ editable: "false", toolbar: false })
  })

  it("reports a refused edit once and remounts on a fresh copy of the saved doc", async () => {
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast")
    vi.mocked(docsApi.postUpdate).mockRejectedValueOnce(new ApiError(400, "DOC_UPDATE_INVALID", "invalid"))
    await mountLoaded()
    const firstEditor = proseMirror().editor

    act(() => {
      firstEditor.chain().focus("end").insertContent(" refused.").run()
    })

    await waitFor(() => expect(proseMirror().editor).not.toBe(firstEditor), { timeout: 2000 })
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    expect({
      toasts: toastError.mock.calls.map(([message]) => message),
      loads: vi.mocked(docsApi.get).mock.calls.length,
    }).toEqual({
      toasts: ["Your last edit couldn't be saved"],
      // The first open, the refused session's own reload, and the fresh session that replaces it.
      loads: 3,
    })
  })

  it("offers Retry when the doc fails to load and loads it on retry", async () => {
    vi.mocked(docsApi.get).mockRejectedValueOnce(new Error("offline"))
    mount()

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }))

    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    expect(docsApi.get).toHaveBeenCalledTimes(2)
  })

  it("keeps one live session under StrictMode: one load in use, one POST per edit, remote updates applied", async () => {
    await mountLoaded(true, { strict: true })

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" for March ").run()
    })
    await waitFor(() => expect(docsApi.postUpdate).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await act(() => gate.dispatch("doc:updated", remoteParagraph("Second shift", 3)))

    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker for March Second shift"))
    await new Promise((resolve) => setTimeout(resolve, FLUSH_CAP_MS + 200))
    expect(docsApi.postUpdate).toHaveBeenCalledTimes(1)
  })

  it("catches up from the loaded seq once the room join is acked, and again after a reconnect", async () => {
    const reconnects = vi.spyOn(contextsModule, "useSocketReconnectCount").mockReturnValue(0)
    const view = await mountLoaded()
    await waitFor(() => expect(docsApi.listUpdates).toHaveBeenCalledTimes(1))

    reconnects.mockReturnValue(1)
    view.rerender(true)

    await waitFor(() => expect(docsApi.listUpdates).toHaveBeenCalledTimes(2))
    expect({
      rooms: joinRoom.mock.calls.map(([, room]) => room),
      afters: vi.mocked(docsApi.listUpdates).mock.calls.map(([, , after]) => after),
    }).toEqual({
      rooms: [`ws:${WORKSPACE_ID}:stream:${DOC_ID}`, `ws:${WORKSPACE_ID}:stream:${DOC_ID}`],
      afters: [1, 1],
    })
  })

  it("applies an update committed between the load and the room join once the join is acked", async () => {
    let ackJoin!: () => void
    joinRoom.mockImplementation(() => new Promise<void>((resolve) => (ackJoin = resolve)))
    await mountLoaded()
    const missed = remoteParagraph("Committed before the join", 2)
    vi.mocked(docsApi.listUpdates).mockResolvedValue({ updates: [missed] })
    expect(docsApi.listUpdates).not.toHaveBeenCalled()

    await act(async () => ackJoin())

    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation trackerCommitted before the join"))
  })

  it("reports reveal-ready once the doc has loaded, not while it loads", async () => {
    let finishLoad!: () => void
    vi.mocked(docsApi.get).mockImplementationOnce(
      () => new Promise<DocState>((resolve) => (finishLoad = () => resolve(docState(serverDoc, 1))))
    )
    const onReveal = vi.fn()
    mount(true, {
      wrap: (body) => (
        <RevealOnReady revealed={false} onReveal={onReveal} fallback={null}>
          {body}
        </RevealOnReady>
      ),
    })
    await waitFor(() => expect(docsApi.get).toHaveBeenCalledTimes(1))
    const whileLoading = onReveal.mock.calls.length

    await act(async () => finishLoad())

    await waitFor(() => expect(onReveal).toHaveBeenCalled())
    expect(whileLoading).toBe(0)
  })

  it("holds the skeleton and the reveal until the viewer's write access resolves", async () => {
    const onReveal = vi.fn()
    const view = mount(null, {
      wrap: (body) => (
        <RevealOnReady revealed={false} onReveal={onReveal} fallback={null}>
          {body}
        </RevealOnReady>
      ),
    })
    await waitFor(() => expect(docsApi.get).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const unresolved = {
      skeleton: screen.queryByLabelText("Loading doc") !== null,
      editor: document.querySelector(".ProseMirror") !== null,
      revealed: onReveal.mock.calls.length > 0,
    }

    view.rerender(true)

    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    expect({ unresolved, revealed: onReveal.mock.calls.length > 0 }).toEqual({
      unresolved: { skeleton: true, editor: false, revealed: false },
      revealed: true,
    })
  })

  it("tells a viewer whose edit was refused for lack of access that the doc is read-only for them", async () => {
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast")
    vi.mocked(docsApi.postUpdate).mockRejectedValueOnce(new ApiError(403, "STREAM_READ_ONLY", "read only"))
    await mountLoaded()

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" refused.").run()
    })

    await waitFor(() => expect(toastError).toHaveBeenCalled(), { timeout: 2000 })
    expect(toastError.mock.calls.map(([message]) => message)).toEqual(["You can't edit this doc"])
  })

  it("follows a write permission change on the same editor", async () => {
    const view = await mountLoaded(true)
    const editor = proseMirror().editor

    view.rerender(false)

    await waitFor(() => expect(proseMirror().getAttribute("contenteditable")).toBe("false"))
    expect({
      sameEditor: proseMirror().editor === editor,
      toolbar: screen.queryByRole("button", { name: "Bold" }) !== null,
    }).toEqual({ sameEditor: true, toolbar: false })
  })

  it("queues unsaved edits and stops listening when the pane closes", async () => {
    const enqueue = vi.spyOn(operationQueueModule, "enqueueDocUpdate").mockResolvedValue()
    const off = vi.spyOn(gate, "off")
    const view = await mountLoaded()

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" closing").run()
    })
    view.unmount()

    await waitFor(() => expect(kickOperationQueue).toHaveBeenCalledTimes(1))
    const [workspaceId, docId] = enqueue.mock.calls[0]
    expect({
      queued: { workspaceId, docId },
      enqueues: enqueue.mock.calls.length,
      posts: vi.mocked(docsApi.postUpdate).mock.calls.length,
      listening: off.mock.calls.map(([event]) => event),
    }).toEqual({
      queued: { workspaceId: WORKSPACE_ID, docId: DOC_ID },
      enqueues: 1,
      posts: 0,
      listening: expect.arrayContaining(["doc:updated"]),
    })
  })

  it("announces the viewer to the doc room and withdraws them when the pane closes", async () => {
    const view = await mountLoaded()
    await waitFor(() => expect(usersSeenByPeer()).toEqual([VIEWER_PRESENCE]))

    view.unmount()

    const last = awarenessFrames().at(-1)!
    expect({
      listened: socket.on.mock.calls.some(([event]) => event === "doc:awareness"),
      stoppedListening: socket.off.mock.calls.some(([event]) => event === "doc:awareness"),
      frameTarget: { workspaceId: last.workspaceId, docId: last.docId },
      afterClose: usersSeenByPeer(),
    }).toEqual({
      listened: true,
      stoppedListening: true,
      frameTarget: { workspaceId: WORKSPACE_ID, docId: DOC_ID },
      afterClose: [],
    })
  })

  it("drops its still-uploading placeholders from the doc when the pane closes mid-upload", async () => {
    const uploadFile = vi.fn(() => new Promise<never>(() => {}))
    vi.spyOn(attachmentsModule, "useAttachments").mockReturnValue({
      uploadFile,
      imageCount: 0,
    } as unknown as ReturnType<typeof attachmentsModule.useAttachments>)
    const view = await mountLoaded()
    act(() => {
      proseMirror().editor.commands.focus("end")
    })

    const file = new File(["png"], "shot.png", { type: "image/png" })
    fireEvent.paste(proseMirror(), { clipboardData: { files: [file], types: ["Files"], getData: () => "" } })
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(docsApi.postUpdate).toHaveBeenCalledTimes(1), { timeout: 2000 })
    view.unmount()

    await waitFor(() => expect(docsApi.postUpdate).toHaveBeenCalledTimes(2))
    const replay = (calls: number) => {
      const replayed = new Y.Doc()
      Y.applyUpdate(replayed, Y.encodeStateAsUpdate(serverDoc))
      for (const [, , update] of vi.mocked(docsApi.postUpdate).mock.calls.slice(0, calls)) {
        Y.applyUpdate(replayed, base64ToBytes(update))
      }
      return JSON.stringify(yDocToProsemirrorJSON(replayed, DOC_FRAGMENT))
    }
    expect({ whileUploading: replay(1), afterClose: replay(2) }).toEqual({
      whileUploading: expect.stringContaining('"type":"attachmentReference"'),
      afterClose: expect.not.stringContaining('"type":"attachmentReference"'),
    })
  })

  it("removes a placeholder whose upload failed instead of leaving an error chip in the shared doc", async () => {
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast")
    let failUpload!: (error: Error) => void
    const uploadFile = vi.fn(() => new Promise<never>((_resolve, reject) => (failUpload = reject)))
    vi.spyOn(attachmentsModule, "useAttachments").mockReturnValue({
      uploadFile,
      imageCount: 0,
    } as unknown as ReturnType<typeof attachmentsModule.useAttachments>)
    await mountLoaded()
    act(() => {
      proseMirror().editor.commands.focus("end")
    })

    const file = new File(["png"], "shot.png", { type: "image/png" })
    fireEvent.paste(proseMirror(), { clipboardData: { files: [file], types: ["Files"], getData: () => "" } })
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1))
    const withPlaceholder = JSON.stringify(proseMirror().editor.getJSON())
    await act(async () => failUpload(new Error("Too large")))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect({
      withPlaceholder: withPlaceholder.includes('"type":"attachmentReference"'),
      afterFailure: JSON.stringify(proseMirror().editor.getJSON()).includes('"type":"attachmentReference"'),
      toasts: toastError.mock.calls.map(([message]) => message),
    }).toEqual({ withPlaceholder: true, afterFailure: false, toasts: ["Couldn't upload the file"] })
  })

  it("should remove the placeholder when the upload is refused before any bytes are sent", async () => {
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast")
    const uploadFile = vi.fn((file: File) =>
      Promise.resolve({
        attachment: {
          id: "temp_refused",
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          status: "error",
          error: "Too large",
        },
        imageIndex: null,
        tempId: "temp_refused",
      })
    )
    vi.spyOn(attachmentsModule, "useAttachments").mockReturnValue({
      uploadFile,
      imageCount: 0,
    } as unknown as ReturnType<typeof attachmentsModule.useAttachments>)
    await mountLoaded()
    act(() => {
      proseMirror().editor.commands.focus("end")
    })

    const file = new File(["zip"], "archive.zip", { type: "application/zip" })
    fireEvent.paste(proseMirror(), { clipboardData: { files: [file], types: ["Files"], getData: () => "" } })

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect({
      afterFailure: JSON.stringify(proseMirror().editor.getJSON()).includes('"type":"attachmentReference"'),
      toasts: toastError.mock.calls.map(([message, options]) => [message, options?.description]),
    }).toEqual({ afterFailure: false, toasts: [["Couldn't upload the file", "Too large"]] })
  })

  it("should upload files picked from the attach button into the doc", async () => {
    const uploadFile = vi.fn(() => new Promise<never>(() => {}))
    vi.spyOn(attachmentsModule, "useAttachments").mockReturnValue({
      uploadFile,
      imageCount: 0,
    } as unknown as ReturnType<typeof attachmentsModule.useAttachments>)
    await mountLoaded()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const openPicker = vi.spyOn(input, "click").mockImplementation(() => {})
    const file = new File(["png"], "shot.png", { type: "image/png" })

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }))
    expect(openPicker).toHaveBeenCalledTimes(1)
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(file))
    expect(JSON.stringify(proseMirror().editor.getJSON())).toContain('"type":"attachmentReference"')
  })

  it("should open an image in the gallery on tap when the doc is read-only", async () => {
    serverDoc = prosemirrorJSONToYDoc(getThreaSchema(), IMAGE_DOC, DOC_FRAGMENT)
    mount(false)

    fireEvent.click(await screen.findByRole("button", { name: "shot.png" }))

    expect(await screen.findByRole("dialog", { name: "shot.png" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Show as link" })).toBeNull()
  })

  it("should open an image in the gallery from its menu when the doc is editable", async () => {
    serverDoc = prosemirrorJSONToYDoc(getThreaSchema(), IMAGE_DOC, DOC_FRAGMENT)
    mount(true)

    fireEvent.click(await screen.findByRole("button", { name: "shot.png" }))
    fireEvent.click(await screen.findByRole("button", { name: "Open" }))

    expect(await screen.findByRole("dialog", { name: "shot.png" })).toBeTruthy()
  })

  it("should browse every image, video and previewable file in the doc from one gallery", async () => {
    const reference = (id: string, filename: string, mimeType: string, display: "inline" | "pill") => ({
      type: "attachmentReference",
      attrs: { id, filename, mimeType, sizeBytes: 3, status: "uploaded", display },
    })
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [reference("attach_shot", "shot.png", "image/png", "inline")] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Notes " },
            reference("attach_notes", "notes.pdf", "application/pdf", "pill"),
          ],
        },
        { type: "paragraph", content: [reference("attach_clip", "clip.mp4", "video/mp4", "inline")] },
        { type: "paragraph", content: [reference("attach_zip", "bundle.zip", "application/zip", "pill")] },
      ],
    }
    vi.spyOn(attachmentsApi, "getDownloadUrl").mockResolvedValue("https://files.test/presigned")
    serverDoc = prosemirrorJSONToYDoc(getThreaSchema(), doc, DOC_FRAGMENT)
    mount(false)

    fireEvent.click(await screen.findByRole("button", { name: "shot.png" }))
    await screen.findByRole("dialog", { name: "shot.png" })
    const strip = screen.getAllByRole("button", { name: /^View / }).map((button) => button.getAttribute("aria-label"))
    fireEvent.keyDown(window, { key: "ArrowRight" })

    expect({
      strip,
      next: await screen.findByRole("dialog", { name: "notes.pdf" }).then(() => true),
      zipOpens: screen.queryByRole("button", { name: "bundle.zip" }),
    }).toEqual({ strip: ["View shot.png", "View notes.pdf", "View clip.mp4"], next: true, zipOpens: null })
  })

  it("should lay a lone image across the doc and side-by-side media out as a row", async () => {
    const image = (id: string) => ({
      type: "attachmentReference",
      attrs: { id, filename: `${id}.png`, mimeType: "image/png", sizeBytes: 3, status: "uploaded", display: "inline" },
    })
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [image("attach_alone")] },
        { type: "paragraph", content: [image("attach_left"), { type: "text", text: " " }, image("attach_right")] },
      ],
    }
    serverDoc = prosemirrorJSONToYDoc(getThreaSchema(), doc, DOC_FRAGMENT)
    mount(false)

    const widthOf = async (name: string) =>
      (await screen.findByRole("button", { name })).closest<HTMLElement>(".react-renderer")!.style.width
    expect({
      alone: await widthOf("attach_alone.png"),
      left: await widthOf("attach_left.png"),
      right: await widthOf("attach_right.png"),
    }).toEqual({
      alone: "calc(1 * (100% - 0.5rem))",
      left: "calc(0.5 * (100% - 1rem))",
      right: "calc(0.5 * (100% - 1rem))",
    })
  })

  it("should add picked images and videos to the doc as media, and other files as chips", async () => {
    const uploadFile = vi.fn(() => new Promise<never>(() => {}))
    vi.spyOn(attachmentsModule, "useAttachments").mockReturnValue({
      uploadFile,
      imageCount: 0,
    } as unknown as ReturnType<typeof attachmentsModule.useAttachments>)
    await mountLoaded()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const files = [
      new File(["png"], "shot.png", { type: "image/png" }),
      new File(["mp4"], "clip.mp4", { type: "video/mp4" }),
      new File(["pdf"], "notes.pdf", { type: "application/pdf" }),
    ]

    fireEvent.change(input, { target: { files } })

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(3))
    const displays: Record<string, unknown> = {}
    proseMirror().editor.state.doc.descendants((node) => {
      if (node.type.name === "attachmentReference") displays[node.attrs.filename as string] = node.attrs.display
    })
    expect(displays).toEqual({ "shot.png": "inline", "clip.mp4": "inline", "notes.pdf": "pill" })
  })

  it("should leave a downward swipe in a short doc to the doc instead of pulling to refresh", async () => {
    await mountLoaded(true, { wrap: (body) => <PullToRefreshHost>{body}</PullToRefreshHost> })
    const editor = proseMirror()

    fireEvent.touchStart(editor, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(editor, { touches: [{ clientY: 400 }] })

    expect(screen.getByTestId("pull-host").dataset.distance).toBe("0")
  })

  it("should drop the caret on Back before leaving the doc on a phone", async () => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(true)
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const docPath = `/w/${WORKSPACE_ID}`
    const router = createMemoryRouter(
      [
        {
          children: [
            { path: "/other", element: <div>other-page</div> },
            {
              path: "/w/:workspaceId",
              element: (
                <MediaGalleryProvider>
                  <DocPane canWrite />
                </MediaGalleryProvider>
              ),
            },
          ],
        },
      ],
      { initialEntries: ["/other", docPath], initialIndex: 1 }
    )
    attachOverlayHistoryRouter(router)
    try {
      render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </QueryClientProvider>
      )
      await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
      const keyBefore = router.state.location.key
      act(() => {
        proseMirror().editor.commands.focus("end")
      })
      await waitFor(() => expect(router.state.location.key).not.toBe(keyBefore))

      await act(async () => {
        await router.navigate(-1)
      })
      await nextFrame()
      const afterFirstBack = { path: router.state.location.pathname, focused: document.activeElement === proseMirror() }
      await act(async () => {
        await router.navigate(-1)
      })

      expect({ afterFirstBack, afterSecondBack: router.state.location.pathname }).toEqual({
        afterFirstBack: { path: docPath, focused: false },
        afterSecondBack: "/other",
      })
    } finally {
      __resetOverlayHistoryForTests()
    }
  })

  it("should format on tap, not on touch, when a wide screen is driven by touch", async () => {
    vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(false)
    vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("touch")
    await mountLoaded()
    act(() => {
      proseMirror().editor.commands.focus("end")
    })
    const bold = screen.getByRole("button", { name: "Bold" })

    fireEvent.pointerDown(bold)
    const onTouch = proseMirror().editor.isActive("bold")
    fireEvent.click(bold)

    expect({ onTouch, onTap: proseMirror().editor.isActive("bold") }).toEqual({ onTouch: false, onTap: true })
  })

  it("should check a task without focusing the doc", async () => {
    serverDoc = prosemirrorJSONToYDoc(
      getThreaSchema(),
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Rotation tracker" }] },
          {
            type: "taskList",
            content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] }],
          },
        ],
      },
      DOC_FRAGMENT
    )
    mount(true)

    fireEvent.click(await screen.findByRole("checkbox"))
    await nextFrame()

    expect({
      checked: proseMirror().editor.state.doc.lastChild?.firstChild?.attrs.checked,
      focused: document.activeElement === proseMirror(),
    }).toEqual({ checked: true, focused: false })
  })

  it("keeps a file dropped beside the editor from opening in place of the app", async () => {
    const uploadFile = vi.fn(() => new Promise<never>(() => {}))
    vi.spyOn(attachmentsModule, "useAttachments").mockReturnValue({
      uploadFile,
      imageCount: 0,
    } as unknown as ReturnType<typeof attachmentsModule.useAttachments>)
    const view = await mountLoaded()
    const scroller = proseMirror().closest(".overflow-y-auto")!
    const file = new File(["png"], "shot.png", { type: "image/png" })
    const drop = () => {
      const event = new Event("drop", { bubbles: true, cancelable: true })
      Object.assign(event, { dataTransfer: { files: [file], types: ["Files"], getData: () => "" } })
      scroller.dispatchEvent(event)
      return event.defaultPrevented
    }

    const writable = drop()
    view.rerender(false)
    await waitFor(() => expect(proseMirror().getAttribute("contenteditable")).toBe("false"))
    const readOnly = drop()

    expect({ writable, readOnly, uploads: uploadFile.mock.calls.length }).toEqual({
      writable: true,
      readOnly: true,
      uploads: 1,
    })
  })

  it("shows a stamped block's comment count beside it, linking to its thread", async () => {
    const blockId = `blk_${"0".repeat(25)}1`
    serverDoc = prosemirrorJSONToYDoc(
      getThreaSchema(),
      {
        type: "doc",
        content: [{ type: "paragraph", attrs: { blockId }, content: [{ type: "text", text: "Rotation tracker" }] }],
      },
      DOC_FRAGMENT
    )
    vi.mocked(docsApi.listThreads).mockResolvedValue({
      threads: [{ blockId, threadId: "stream_thread", replyCount: 1 }],
    })

    await mountLoaded()

    expect((await screen.findByRole("link", { name: "1 comment on this block" })).getAttribute("href")).toBe(
      `/w/${WORKSPACE_ID}?panel=stream_thread`
    )
  })

  describe("useDocSync", () => {
    beforeEach(() => {
      queryClient = new QueryClient()
    })

    const withQueryClient = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    it("marks the doc open on this device while mounted, across a doc change", async () => {
      const { rerender, unmount } = renderHook(({ docId }) => useDocSync(WORKSPACE_ID, docId), {
        wrapper: withQueryClient,
        initialProps: { docId: DOC_ID as string | null },
      })
      expect(getOpenDocIds()).toEqual([DOC_ID])

      rerender({ docId: "stream_other" })
      expect(getOpenDocIds()).toEqual(["stream_other"])

      unmount()
      expect(getOpenDocIds()).toEqual([])
    })

    it("opens no session and touches no socket when the doc id is null", async () => {
      const { result } = renderHook(() => useDocSync(WORKSPACE_ID, null), { wrapper: withQueryClient })
      await act(async () => {})

      expect({
        view: result.current,
        loads: vi.mocked(docsApi.get).mock.calls.length,
        listeners: socket.on.mock.calls.length,
        frames: socket.emit.mock.calls.length,
        joins: joinRoom.mock.calls.length,
      }).toEqual({ view: { phase: "loading" }, loads: 0, listeners: 0, frames: 0, joins: 0 })
    })

    it("withdraws the viewer from the old doc before stopping its sync when the doc id changes", async () => {
      const order: string[] = []
      socket.emit.mockImplementation((event: string, payload: DocAwarenessPayload) => {
        if (event === "doc:awareness") order.push(`frame:${payload.docId}`)
      })
      const stop = DocSync.prototype.stop
      vi.spyOn(DocSync.prototype, "stop").mockImplementation(function (this: DocSync) {
        order.push("stop")
        stop.call(this)
      })
      const { result, rerender } = renderHook(({ docId }) => useDocSync(WORKSPACE_ID, docId), {
        wrapper: withQueryClient,
        initialProps: { docId: DOC_ID },
      })
      await waitFor(() => expect(result.current.phase).toBe("ready"))
      await waitFor(() => expect(usersSeenByPeer()).toEqual([VIEWER_PRESENCE]))
      order.length = 0

      rerender({ docId: "stream_other" })

      expect({ order: order.slice(0, 2), seenInOldDoc: usersSeenByPeer() }).toEqual({
        order: [`frame:${DOC_ID}`, "stop"],
        seenInOldDoc: [],
      })
    })

    it("re-sends the viewer's presence when the room join is acked after a reconnect", async () => {
      const reconnects = vi.spyOn(contextsModule, "useSocketReconnectCount").mockReturnValue(0)
      const { rerender } = renderHook(() => useDocSync(WORKSPACE_ID, DOC_ID), { wrapper: withQueryClient })
      await waitFor(() => expect(usersSeenByPeer()).toEqual([VIEWER_PRESENCE]))
      await new Promise((resolve) => setTimeout(resolve, PRESENCE_SEND_WINDOW_MS * 2))
      const before = awarenessFrames().length

      reconnects.mockReturnValue(1)
      rerender()

      await waitFor(() => expect(joinRoom).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(usersSeenByPeer(awarenessFrames().slice(before))).toEqual([VIEWER_PRESENCE]))
    })

    it("withdraws the viewer on pagehide and announces them again on pageshow", async () => {
      renderHook(() => useDocSync(WORKSPACE_ID, DOC_ID), { wrapper: withQueryClient })
      await waitFor(() => expect(usersSeenByPeer()).toEqual([VIEWER_PRESENCE]))

      act(() => {
        window.dispatchEvent(new Event("pagehide"))
      })
      const afterHide = usersSeenByPeer()
      act(() => {
        window.dispatchEvent(new Event("pageshow"))
      })

      await waitFor(() =>
        expect({ afterHide, afterShow: usersSeenByPeer() }).toEqual({ afterHide: [], afterShow: [VIEWER_PRESENCE] })
      )
    })
  })
  describe("block landing", () => {
    let scrolled: Element[]
    const originalScrollIntoView = Element.prototype.scrollIntoView

    beforeEach(() => {
      scrolled = []
      serverDoc = prosemirrorJSONToYDoc(
        getThreaSchema(),
        {
          type: "doc",
          content: [
            { type: "paragraph", attrs: { blockId: "blk_intro" }, content: [{ type: "text", text: "Intro" }] },
            { type: "paragraph", attrs: { blockId: "blk_rota" }, content: [{ type: "text", text: "Rota" }] },
          ],
        },
        DOC_FRAGMENT
      )
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this)
      }
    })

    afterEach(() => {
      Element.prototype.scrollIntoView = originalScrollIntoView
      vi.useRealTimers()
      takeBlockFocus(DOC_ID)
    })

    async function mountBlocks() {
      mount()
      await waitFor(() => expect(proseMirror().textContent).toBe("IntroRota"))
    }

    const rota = () => screen.getByText("Rota")
    const highlighted = () =>
      [...document.querySelectorAll(".ProseMirror > *")].filter((el) => el.classList.contains("bg-primary/10"))

    it("should scroll to and briefly highlight the requested block when the doc opens with a request pending", async () => {
      requestBlockFocus(DOC_ID, "blk_rota")
      await mountBlocks()

      await waitFor(() => expect(scrolled).toEqual([rota()]))
      expect(highlighted()).toEqual([rota()])
      await waitFor(() => expect(highlighted()).toEqual([]), {
        timeout: BLOCK_HIGHLIGHT_MS + 1000,
      })
    })

    it("should land a request that arrives while the doc is already open", async () => {
      await mountBlocks()
      vi.useFakeTimers()

      act(() => requestBlockFocus(DOC_ID, "blk_rota"))
      const during = { scrolled: [...scrolled], highlighted: highlighted() }
      act(() => vi.advanceTimersByTime(BLOCK_HIGHLIGHT_MS))

      expect({ ...during, after: highlighted() }).toEqual({
        scrolled: [rota()],
        highlighted: [rota()],
        after: [],
      })
    })

    it("should do nothing when the requested block is not in the doc", async () => {
      await mountBlocks()
      act(() => requestBlockFocus(DOC_ID, "blk_missing"))

      expect({ scrolled, highlighted: highlighted() }).toEqual({
        scrolled: [],
        highlighted: [],
      })
    })

    it("should list the docs linking here below the doc when the API returns backlinks", async () => {
      vi.spyOn(docsApi, "listBacklinks").mockResolvedValue({
        backlinks: [{ docId: "stream_plan", title: "Launch plan", hostStreamId: "stream_eng", blockIds: ["blk_a"] }],
      })
      await mountBlocks()

      const link = await screen.findByRole("link", { name: /Launch plan/ })
      expect({
        heading: screen.getByRole("heading", { name: "Linked from" }) !== null,
        href: link.getAttribute("href"),
      }).toEqual({ heading: true, href: `/w/${WORKSPACE_ID}?panel=stream_plan` })
    })

    it("should refetch open backlink lists once the server applies a local edit", async () => {
      await mountBlocks()
      await waitFor(() => expect(docsApi.listBacklinks).toHaveBeenCalledTimes(1))
      vi.spyOn(docsApi, "listBacklinks").mockResolvedValue({
        backlinks: [{ docId: "stream_plan", title: "Launch plan", hostStreamId: "stream_eng", blockIds: ["blk_a"] }],
      })

      act(() => {
        proseMirror().editor.chain().focus("end").insertContent(" done ").run()
      })

      expect(await screen.findByRole("link", { name: /Launch plan/ }, { timeout: 2000 })).not.toBeNull()
    })
  })
})
