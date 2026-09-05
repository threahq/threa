import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { StreamDropZone, DraggableStreamRow, STREAM_DRAG_TYPE } from "./sidebar-dnd"

/** jsdom ships no DataTransfer, so stand one up over a plain map. */
function stubDataTransfer() {
  const store = new Map<string, string>()
  return {
    dropEffect: "none",
    effectAllowed: "none",
    get types() {
      return [...store.keys()]
    },
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
  }
}

function dropZone(onDropStream: (streamId: string) => void, props?: { enabled?: boolean; workspaceId?: string }) {
  render(
    <StreamDropZone
      enabled={props?.enabled ?? true}
      workspaceId={props?.workspaceId ?? "ws_1"}
      onDropStream={onDropStream}
    >
      <div>Reading</div>
    </StreamDropZone>
  )
  return screen.getByText("Reading").parentElement!
}

describe("DraggableStreamRow", () => {
  it("puts the stream's canonical permalink on the drag, not the row's href", () => {
    render(
      <DraggableStreamRow workspaceId="ws_1" streamId="stream_1" label="Pi <remote> control">
        <a href="/w/ws_1/board?scope=stream_1">Pi remote control</a>
      </DraggableStreamRow>
    )
    const dataTransfer = stubDataTransfer()
    fireEvent.dragStart(screen.getByText("Pi remote control"), { dataTransfer })
    fireEvent.dragEnd(screen.getByText("Pi remote control"), { dataTransfer })

    const link = `${window.location.origin}/w/ws_1/s/stream_1`
    expect({
      uriList: dataTransfer.getData("text/uri-list"),
      plain: dataTransfer.getData("text/plain"),
      html: dataTransfer.getData("text/html"),
      payload: JSON.parse(dataTransfer.getData(STREAM_DRAG_TYPE)),
    }).toEqual({
      uriList: link,
      plain: link,
      html: `<a href="${link}">Pi &lt;remote&gt; control</a>`,
      payload: { workspaceId: "ws_1", streamId: "stream_1" },
    })
  })

  it("swallows a drop nobody handled, so a missed drag can't navigate the app away", () => {
    render(
      <DraggableStreamRow workspaceId="ws_1" streamId="stream_1" label="Pi remote control">
        <a href="/w/ws_1/s/stream_1">Pi remote control</a>
      </DraggableStreamRow>
    )
    const row = screen.getByText("Pi remote control")
    fireEvent.dragStart(row, { dataTransfer: stubDataTransfer() })

    const missed = new Event("drop", { bubbles: true, cancelable: true })
    window.dispatchEvent(missed)
    expect(missed.defaultPrevented).toBe(true)

    fireEvent.dragEnd(row, { dataTransfer: stubDataTransfer() })

    const afterDrag = new Event("drop", { bubbles: true, cancelable: true })
    window.dispatchEvent(afterDrag)
    expect(afterDrag.defaultPrevented).toBe(false)
  })

  it("leaves a drop a real target already claimed alone", () => {
    render(
      <DraggableStreamRow workspaceId="ws_1" streamId="stream_1" label="Pi remote control">
        <a href="/w/ws_1/s/stream_1">Pi remote control</a>
      </DraggableStreamRow>
    )
    const row = screen.getByText("Pi remote control")
    fireEvent.dragStart(row, { dataTransfer: stubDataTransfer() })

    const claimed = new Event("dragover", { bubbles: true, cancelable: true })
    claimed.preventDefault()
    const dataTransfer = stubDataTransfer()
    Object.defineProperty(claimed, "dataTransfer", { value: dataTransfer })
    dataTransfer.dropEffect = "move"
    window.dispatchEvent(claimed)

    expect(dataTransfer.dropEffect).toBe("move")
    fireEvent.dragEnd(row, { dataTransfer: stubDataTransfer() })
  })
})

describe("StreamDropZone", () => {
  it("files the dragged stream when a stream drag is dropped on it", () => {
    const onDropStream = vi.fn()
    const zone = dropZone(onDropStream)
    const dataTransfer = stubDataTransfer()
    dataTransfer.setData(STREAM_DRAG_TYPE, JSON.stringify({ workspaceId: "ws_1", streamId: "stream_1" }))

    fireEvent.dragOver(zone, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe("move")

    fireEvent.drop(zone, { dataTransfer })
    expect(onDropStream).toHaveBeenCalledWith("stream_1")
  })

  it("ignores a stream dragged in from another workspace's window", () => {
    const onDropStream = vi.fn()
    const zone = dropZone(onDropStream)
    const dataTransfer = stubDataTransfer()
    dataTransfer.setData(STREAM_DRAG_TYPE, JSON.stringify({ workspaceId: "ws_2", streamId: "stream_1" }))

    fireEvent.drop(zone, { dataTransfer })
    expect(onDropStream).not.toHaveBeenCalled()
  })

  it("ignores a drag that carries no stream, so a dropped file or link falls through", () => {
    const onDropStream = vi.fn()
    const zone = dropZone(onDropStream)
    const dataTransfer = stubDataTransfer()
    dataTransfer.setData("text/uri-list", "https://example.com")

    fireEvent.drop(zone, { dataTransfer })
    expect(onDropStream).not.toHaveBeenCalled()
  })

  it("ignores a stream drop while dragging is disabled (touch)", () => {
    const onDropStream = vi.fn()
    const zone = dropZone(onDropStream, { enabled: false })
    const dataTransfer = stubDataTransfer()
    dataTransfer.setData(STREAM_DRAG_TYPE, JSON.stringify({ workspaceId: "ws_1", streamId: "stream_1" }))

    fireEvent.drop(zone, { dataTransfer })
    expect(onDropStream).not.toHaveBeenCalled()
  })
})
