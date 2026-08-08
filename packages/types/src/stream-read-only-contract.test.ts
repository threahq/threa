import { describe, expect, test } from "bun:test"
import {
  STREAM_READ_ONLY_REASONS,
  StreamErrorCodes,
  StreamReadOnlyReasons,
  type Stream,
  type StreamReadOnlyReason,
  type StreamViewerState,
  type StreamWithPreview,
  type ViewerStream,
  type ViewerStreamWithPreview,
} from "./index"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

type _Reason = Assert<Equal<StreamReadOnlyReason, "archived" | "system_stream" | "not_a_member">>
type _State = Assert<Equal<StreamViewerState, { readOnly: boolean; readOnlyReason: StreamReadOnlyReason | null }>>
type _ViewerStream = Assert<Equal<ViewerStream, Stream & StreamViewerState>>
type _ViewerStreamWithPreview = Assert<Equal<ViewerStreamWithPreview, StreamWithPreview & StreamViewerState>>

const compileTimeContract: [_Reason, _State, _ViewerStream, _ViewerStreamWithPreview] = [true, true, true, true]

describe("stream read-only contract", () => {
  test("pins exact reason and error literals", () => {
    expect({
      reasons: STREAM_READ_ONLY_REASONS,
      reasonObject: StreamReadOnlyReasons,
      errorCode: StreamErrorCodes.READ_ONLY,
      compileTimeContract,
    }).toEqual({
      reasons: ["archived", "system_stream", "not_a_member"],
      reasonObject: {
        ARCHIVED: "archived",
        SYSTEM_STREAM: "system_stream",
        NOT_A_MEMBER: "not_a_member",
      },
      errorCode: "STREAM_READ_ONLY",
      compileTimeContract: [true, true, true, true],
    })
  })
})
