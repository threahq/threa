import {
  MediaConvertClient,
  CreateJobCommand,
  GetJobCommand,
  DescribeEndpointsCommand,
  JobStatus,
  type CreateJobCommandInput,
} from "@aws-sdk/client-mediaconvert"
import { logger } from "../../../lib/logger"
import type { S3Config, MediaConvertConfig } from "../../../lib/env"

export interface MediaConvertClientConfig {
  s3Config: S3Config
  mediaConvertConfig: MediaConvertConfig
}

export interface SubmitTranscodeJobInput {
  clientRequestToken: string
  s3InputKey: string
  s3OutputPrefix: string
}

export interface TranscodeJobStatus {
  status: "SUBMITTED" | "PROGRESSING" | "COMPLETE" | "ERROR" | "CANCELED"
  errorMessage?: string
  /** Output file paths from the completed job */
  outputPaths?: string[]
}

/**
 * Wrapper around AWS MediaConvert SDK.
 * Constructed once at startup (INV-13).
 */
export class ThreaMediaConvertClient {
  private client: MediaConvertClient
  private readonly s3Config: S3Config
  private readonly mediaConvertConfig: MediaConvertConfig
  private cachedEndpoint: string | null = null

  constructor(config: MediaConvertClientConfig) {
    this.s3Config = config.s3Config
    this.mediaConvertConfig = config.mediaConvertConfig

    if (!config.mediaConvertConfig.roleArn) {
      throw new Error("MediaConvert role ARN is required when video transcoding is enabled")
    }

    this.client = new MediaConvertClient({
      region: config.s3Config.region,
      credentials: {
        accessKeyId: config.s3Config.accessKeyId,
        secretAccessKey: config.s3Config.secretAccessKey,
      },
    })
  }

  /**
   * Discover and cache the account-specific MediaConvert endpoint.
   * MediaConvert requires using a per-account endpoint for job operations.
   */
  async discoverEndpoint(): Promise<string> {
    if (this.cachedEndpoint) return this.cachedEndpoint

    if (this.mediaConvertConfig.endpoint) {
      this.cachedEndpoint = this.mediaConvertConfig.endpoint
      this.client = new MediaConvertClient({
        region: this.s3Config.region,
        endpoint: this.cachedEndpoint,
        credentials: {
          accessKeyId: this.s3Config.accessKeyId,
          secretAccessKey: this.s3Config.secretAccessKey,
        },
      })
      return this.cachedEndpoint
    }

    const response = await this.client.send(new DescribeEndpointsCommand({ MaxResults: 1 }))
    const endpoint = response.Endpoints?.[0]?.Url
    if (!endpoint) {
      throw new Error("Failed to discover MediaConvert endpoint")
    }

    this.cachedEndpoint = endpoint

    // Recreate the client with the account-specific endpoint
    this.client = new MediaConvertClient({
      region: this.s3Config.region,
      endpoint,
      credentials: {
        accessKeyId: this.s3Config.accessKeyId,
        secretAccessKey: this.s3Config.secretAccessKey,
      },
    })

    logger.info({ endpoint }, "Discovered MediaConvert endpoint")
    return endpoint
  }

  /**
   * Submit a transcode job to MediaConvert.
   * Produces an H.264 MP4 output + a JPEG thumbnail frame capture.
   */
  async submitTranscodeJob(input: SubmitTranscodeJobInput): Promise<string> {
    await this.discoverEndpoint()

    const s3InputUri = `s3://${this.s3Config.bucket}/${input.s3InputKey}`
    const s3OutputUri = `s3://${this.s3Config.bucket}/${input.s3OutputPrefix}`

    const jobParams: CreateJobCommandInput = {
      ClientRequestToken: input.clientRequestToken,
      Role: this.mediaConvertConfig.roleArn,
      Settings: {
        Inputs: [
          {
            FileInput: s3InputUri,
            AudioSelectors: {
              "Audio Selector 1": {
                DefaultSelection: "DEFAULT",
              },
            },
            VideoSelector: {},
          },
        ],
        OutputGroups: [
          {
            Name: "MP4 Output",
            OutputGroupSettings: {
              Type: "FILE_GROUP_SETTINGS",
              FileGroupSettings: {
                Destination: `${s3OutputUri}processed`,
              },
            },
            Outputs: [
              {
                ContainerSettings: {
                  Container: "MP4",
                  Mp4Settings: {},
                },
                VideoDescription: {
                  CodecSettings: {
                    Codec: "H_265",
                    H265Settings: {
                      RateControlMode: "QVBR",
                      QvbrSettings: {
                        QvbrQualityLevel: 7,
                      },
                      MaxBitrate: 3_000_000,
                      CodecProfile: "MAIN_MAIN",
                      CodecLevel: "AUTO",
                    },
                  },
                  // Let MediaConvert auto-detect width/height from source
                },
                AudioDescriptions: [
                  {
                    CodecSettings: {
                      Codec: "AAC",
                      AacSettings: {
                        Bitrate: 128_000,
                        CodingMode: "CODING_MODE_2_0",
                        SampleRate: 48_000,
                      },
                    },
                  },
                ],
              },
            ],
          },
          {
            Name: "Thumbnail",
            OutputGroupSettings: {
              Type: "FILE_GROUP_SETTINGS",
              FileGroupSettings: {
                Destination: `${s3OutputUri}thumbnail`,
              },
            },
            Outputs: [
              {
                ContainerSettings: {
                  Container: "RAW",
                },
                VideoDescription: {
                  CodecSettings: {
                    Codec: "FRAME_CAPTURE",
                    FrameCaptureSettings: {
                      FramerateNumerator: 1,
                      FramerateDenominator: 1,
                      MaxCaptures: 1,
                    },
                  },
                  Width: 640,
                },
              },
            ],
          },
        ],
      },
    }

    const response = await this.client.send(new CreateJobCommand(jobParams))
    const jobId = response.Job?.Id
    if (!jobId) {
      throw new Error("MediaConvert CreateJob did not return a job ID")
    }

    logger.info({ mediaconvertJobId: jobId, s3Input: input.s3InputKey }, "MediaConvert job submitted")
    return jobId
  }

  async getJobStatus(mediaconvertJobId: string): Promise<TranscodeJobStatus> {
    await this.discoverEndpoint()

    const response = await this.client.send(new GetJobCommand({ Id: mediaconvertJobId }))
    const job = response.Job
    if (!job) {
      throw new Error(`MediaConvert job ${mediaconvertJobId} not found`)
    }

    const status = job.Status as TranscodeJobStatus["status"]

    if (status === JobStatus.ERROR || status === "CANCELED") {
      return {
        status,
        errorMessage: job.ErrorMessage ?? `Job ${status.toLowerCase()}`,
      }
    }

    return { status }
  }
}
