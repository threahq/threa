import type { Stream, StreamType } from "@threahq/types"
import { StreamTypes } from "@threahq/types"

/** Only id and type are required; everything else has defaults. */
export function createMockStream(overrides: Partial<Stream> & { id: string; type: StreamType }): Stream {
  return {
    workspaceId: "workspace_1",
    displayName: null,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    archivedAt: null,
    ...overrides,
  }
}

export const mockStreams = {
  scratchpad: createMockStream({
    id: "stream_scratchpad1",
    type: StreamTypes.SCRATCHPAD as StreamType,
    displayName: "My Notes",
  }),

  general: createMockStream({
    id: "stream_channel1",
    type: StreamTypes.CHANNEL as StreamType,
    displayName: "General",
    slug: "general",
  }),

  random: createMockStream({
    id: "stream_channel2",
    type: StreamTypes.CHANNEL as StreamType,
    displayName: "Random",
    slug: "random",
  }),

  dm: createMockStream({
    id: "stream_dm1",
    type: StreamTypes.DM as StreamType,
    displayName: "Martin",
  }),
}

export const mockStreamsList: Stream[] = Object.values(mockStreams)
