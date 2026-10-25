import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { Editor, JSONContent } from "@tiptap/core"
import * as Y from "yjs"
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocState, DocUpdatedOutboxPayload, Stream } from "@threahq/types"
import { toast } from "sonner"
import { ApiError } from "@/api/client"
import { docsApi } from "@/api/docs"
import { TooltipProvider } from "@/components/ui/tooltip"
import * as contextsModule from "@/contexts"
import * as attachmentsModule from "@/hooks/use-attachments"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceEmojiModule from "@/hooks/use-workspace-emoji"
import * as socketRoomModule from "@/lib/socket-room"
import * as syncEngineModule from "@/sync/sync-engine"
import { SocketEventGate } from "@/sync/socket-event-gate"
import * as triggersModule from "@/components/editor/triggers"
import { DocPaneBody } from "./doc-pane-body"

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

describe("DocPaneBody", () => {
  let gate: SocketEventGate
  let serverDoc: Y.Doc
  let queryClient: QueryClient

  beforeEach(() => {
    serverDoc = prosemirrorJSONToYDoc(getThreaSchema(), paragraphs("Rotation tracker"), "default")
    gate = new SocketEventGate(WORKSPACE_ID)
    const socket = { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: true }
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(
      socket as unknown as ReturnType<typeof contextsModule.useSocket>
    )
    vi.spyOn(contextsModule, "useSocketReconnectCount").mockReturnValue(0)
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { keyboardShortcuts: {} },
      isLoading: false,
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(socketRoomModule, "joinRoomFireAndForget").mockImplementation(() => {})
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      getLiveEventSource: () => gate,
      backfillStreamGap: vi.fn(),
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
    vi.spyOn(docsApi, "postUpdate").mockResolvedValue({ seq: 2, touchedBlockIds: [] })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function tree(canWrite: boolean) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}`]}>
            <Routes>
              <Route
                path="/w/:workspaceId"
                element={<DocPaneBody workspaceId={WORKSPACE_ID} stream={{ id: DOC_ID }} canWrite={canWrite} />}
              />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    )
  }

  function mount(canWrite = true, { strict = false } = {}) {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(strict ? <StrictMode>{tree(canWrite)}</StrictMode> : tree(canWrite))
    return {
      ...view,
      rerender: (next: boolean) => view.rerender(strict ? <StrictMode>{tree(next)}</StrictMode> : tree(next)),
    }
  }

  function remoteParagraph(text: string, seq: number): DocUpdatedOutboxPayload {
    const before = Y.encodeStateVector(serverDoc)
    const paragraph = new Y.XmlElement("paragraph")
    paragraph.insert(0, [new Y.XmlText(text)])
    serverDoc.getXmlFragment("default").push([paragraph])
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

  it("renders the loaded doc in an editable editor with the formatting toolbar", async () => {
    mount()

    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    expect({
      editable: proseMirror().getAttribute("contenteditable"),
      toolbar: screen.queryByRole("button", { name: "Bold" }) !== null,
    }).toEqual({ editable: "true", toolbar: true })
  })

  it("posts a local edit once after the debounce", async () => {
    mount()
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" for March").run()
    })

    await waitFor(() => expect(docsApi.postUpdate).toHaveBeenCalledTimes(1), { timeout: 2000 })
    const posted = new Y.Doc()
    Y.applyUpdate(posted, Y.encodeStateAsUpdate(serverDoc))
    const [workspaceId, docId, update] = vi.mocked(docsApi.postUpdate).mock.calls[0]
    Y.applyUpdate(posted, base64ToBytes(update))
    expect({ workspaceId, docId, text: posted.getXmlFragment("default").toString() }).toEqual({
      workspaceId: WORKSPACE_ID,
      docId: DOC_ID,
      text: expect.stringContaining("Rotation tracker for March"),
    })
  })

  it("shows a remote update delivered through the live event source", async () => {
    mount()
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))

    const payload = remoteParagraph("Second shift", 2)
    await act(() => gate.dispatch("doc:updated", payload))

    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation trackerSecond shift"))
    expect(docsApi.listUpdates).not.toHaveBeenCalled()
  })

  it("gives a read-only viewer no toolbar and a non-editable editor", async () => {
    mount(false)

    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    expect({
      editable: proseMirror().getAttribute("contenteditable"),
      toolbar: screen.queryByRole("button", { name: "Bold" }) !== null,
    }).toEqual({ editable: "false", toolbar: false })
  })

  it("reports a refused edit once and remounts on a fresh copy of the saved doc", async () => {
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast")
    vi.mocked(docsApi.postUpdate).mockRejectedValueOnce(new ApiError(400, "DOC_UPDATE_INVALID", "invalid"))
    mount()
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    const firstEditor = proseMirror().editor

    act(() => {
      firstEditor.chain().focus("end").insertContent(" refused").run()
    })

    await waitFor(() => expect(proseMirror().editor).not.toBe(firstEditor), { timeout: 2000 })
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    expect({
      toasts: toastError.mock.calls.map(([message]) => message),
      loads: vi.mocked(docsApi.get).mock.calls.length,
    }).toEqual({
      toasts: ["Your last edit couldn't be saved"],
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
    mount(true, { strict: true })
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" for March").run()
    })
    await waitFor(() => expect(docsApi.postUpdate).toHaveBeenCalledTimes(1), { timeout: 2000 })
    await act(() => gate.dispatch("doc:updated", remoteParagraph("Second shift", 3)))

    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker for MarchSecond shift"))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(docsApi.postUpdate).toHaveBeenCalledTimes(1)
  })

  it("catches up after a socket reconnect, not on first mount", async () => {
    const reconnects = vi.spyOn(contextsModule, "useSocketReconnectCount").mockReturnValue(0)
    const view = mount()
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    const beforeReconnect = vi.mocked(docsApi.listUpdates).mock.calls.length

    reconnects.mockReturnValue(1)
    view.rerender(true)

    await waitFor(() => expect(docsApi.listUpdates).toHaveBeenCalledTimes(1))
    expect({ beforeReconnect, call: vi.mocked(docsApi.listUpdates).mock.calls[0] }).toEqual({
      beforeReconnect: 0,
      call: [WORKSPACE_ID, DOC_ID, 1],
    })
  })

  it("follows a write permission change on the same editor", async () => {
    const view = mount(true)
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
    const editor = proseMirror().editor

    view.rerender(false)

    await waitFor(() => expect(proseMirror().getAttribute("contenteditable")).toBe("false"))
    expect({
      sameEditor: proseMirror().editor === editor,
      toolbar: screen.queryByRole("button", { name: "Bold" }) !== null,
    }).toEqual({ sameEditor: true, toolbar: false })
  })

  it("sends unsaved edits and stops listening when the pane closes", async () => {
    const off = vi.spyOn(gate, "off")
    const view = mount()
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))

    act(() => {
      proseMirror().editor.chain().focus("end").insertContent(" closing").run()
    })
    view.unmount()

    await waitFor(() => expect(docsApi.postUpdate).toHaveBeenCalledTimes(1))
    expect(off.mock.calls.map(([event]) => event)).toContain("doc:updated")
  })

  it("drops its still-uploading placeholders from the doc when the pane closes mid-upload", async () => {
    const uploadFile = vi.fn(() => new Promise<never>(() => {}))
    vi.spyOn(attachmentsModule, "useAttachments").mockReturnValue({
      uploadFile,
      imageCount: 0,
    } as unknown as ReturnType<typeof attachmentsModule.useAttachments>)
    const view = mount()
    await waitFor(() => expect(proseMirror().textContent).toBe("Rotation tracker"))
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
      return JSON.stringify(yDocToProsemirrorJSON(replayed, "default"))
    }
    expect({ whileUploading: replay(1), afterClose: replay(2) }).toEqual({
      whileUploading: expect.stringContaining('"type":"attachmentReference"'),
      afterClose: expect.not.stringContaining('"type":"attachmentReference"'),
    })
  })
})
