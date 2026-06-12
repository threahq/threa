import { z } from "zod"
import type { Request, Response } from "express"
import type { WorkspaceService } from "./service"
import type { StreamService } from "../streams"
import type { UserPreferencesService } from "../user-preferences"
import type { WorkspaceSettingsService } from "../workspace-settings"
import type { FeatureFlagService } from "../feature-flags"
import type { SidebarConfigService } from "../sidebar-config"
import type { InvitationService } from "../invitations"
import type { ActivityService } from "../activity"
import type { CommandAvailabilityService } from "../commands"
import type { AvatarService } from "./avatar-service"
import type { LabelService, LabelAssignmentService } from "../labels"
import { getEmojiList } from "../emoji"
import { getEffectiveLevel } from "../streams"
import { BotRepository, serializeBot } from "../public-api"
import { displayNameFromWorkos, type WorkosOrgService } from "@threa/backend-common"
import { HttpError } from "../../lib/errors"
import { setStatusSchema, setNotificationPauseSchema } from "../../lib/schemas"
import {
  parseJwtPermissions,
  permissionsForRole,
  WORKSPACE_PERMISSION_SCOPES,
  type WorkspacePermissionSlug,
} from "@threa/types"

const createWorkspaceSchema = z.object({
  name: z.string().min(1, "name is required"),
})

const completeUserSetupSchema = z.object({
  name: z.string().min(1, "name is required").optional(),
  slug: z.string().optional(),
  timezone: z.string().min(1, "timezone is required"),
  locale: z.string().min(1, "locale is required"),
})

const updateProfileSchema = z.object({
  name: z.string().min(1, "name is required").max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  pronouns: z.string().max(50).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  githubUsername: z.string().max(39).nullable().optional(),
})

const checkSlugAvailableSchema = z.object({
  slug: z.string().min(1, "slug query parameter is required"),
})

export { createWorkspaceSchema }

interface Dependencies {
  workspaceService: WorkspaceService
  streamService: StreamService
  userPreferencesService: UserPreferencesService
  workspaceSettingsService: WorkspaceSettingsService
  featureFlagService: FeatureFlagService
  sidebarConfigService: SidebarConfigService
  invitationService: InvitationService
  activityService?: ActivityService
  commandAvailabilityService: CommandAvailabilityService
  avatarService: AvatarService
  labelService: LabelService
  labelAssignmentService: LabelAssignmentService
  workosOrgService: WorkosOrgService
  pool: import("pg").Pool
}

export function createWorkspaceHandlers({
  workspaceService,
  streamService,
  userPreferencesService,
  workspaceSettingsService,
  featureFlagService,
  sidebarConfigService,
  invitationService,
  activityService,
  commandAvailabilityService,
  avatarService,
  labelService,
  labelAssignmentService,
  workosOrgService,
  pool,
}: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      // Pre-workspace route: uses WorkOS identity (no workspace user context yet)
      const workosUserId = req.workosUserId!
      const workspaces = await workspaceService.getWorkspacesByWorkosUserId(workosUserId)
      res.json({ workspaces })
    },

    async get(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const workspace = await workspaceService.getWorkspaceById(workspaceId)

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" })
      }

      res.json({ workspace })
    },

    async create(req: Request, res: Response) {
      // Pre-workspace route: uses WorkOS identity (no workspace user context yet)
      const workosUserId = req.workosUserId!
      const authUser = req.authUser

      const result = createWorkspaceSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      if (!authUser) {
        throw new HttpError("Not authenticated", { status: 401, code: "NOT_AUTHENTICATED" })
      }

      const userName = displayNameFromWorkos(authUser)
      const workspace = await workspaceService.createWorkspace({
        name: result.data.name,
        workosUserId,
        email: authUser.email,
        userName,
      })

      res.status(201).json({ workspace })
    },

    async getUsers(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const users = await workspaceService.getUsers(workspaceId)
      res.json({ users })
    },

    async bootstrap(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const [
        workspace,
        users,
        streams,
        personas,
        bots,
        emojiWeights,
        userPreferences,
        workspaceSettings,
        featureFlags,
        sidebarConfig,
        dmPeers,
        labels,
        labelMemberships,
        labelAssignments,
      ] = await Promise.all([
        workspaceService.getWorkspaceById(workspaceId),
        workspaceService.getUsers(workspaceId),
        streamService.listWithPreviews(workspaceId, userId),
        workspaceService.getPersonasForWorkspace(workspaceId),
        BotRepository.listVisibleTo(pool, workspaceId, userId),
        workspaceService.getEmojiWeights(workspaceId, userId),
        userPreferencesService.getPreferences(workspaceId, userId),
        workspaceSettingsService.getSettings(workspaceId),
        featureFlagService.getFlags(workspaceId, userId),
        sidebarConfigService.getConfig(workspaceId, userId),
        streamService.listDmPeers(workspaceId, userId),
        labelService.listVisibleTo(workspaceId, userId),
        labelService.listMembershipsForUser(workspaceId, userId),
        labelAssignmentService.listForViewer(workspaceId, userId),
      ])

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" })
      }

      // Resolve DM display names — viewer-dependent, so computed at bootstrap time
      const resolvedStreams = await streamService.resolveDmDisplayNames(streams, users, userId)

      const streamMemberships = await streamService.getMembershipsBatch(
        resolvedStreams.map((s) => s.id),
        userId
      )

      // Calculate unread counts for all streams based on memberships
      const [unreadCountsMap, activityCounts] = await Promise.all([
        streamService.getUnreadCounts(
          streamMemberships.map((m) => ({ streamId: m.streamId, lastReadEventId: m.lastReadEventId }))
        ),
        activityService?.getUnreadCounts(userId, workspaceId),
      ])
      const unreadCounts: Record<string, number> = {}
      const messageCounts: Record<string, number> = {}
      for (const [streamId, counts] of unreadCountsMap) {
        unreadCounts[streamId] = counts.unreadCount
        messageCounts[streamId] = counts.totalCount
      }

      const mentionCounts: Record<string, number> = {}
      const activityCountsPerStream: Record<string, number> = {}
      if (activityCounts) {
        for (const [streamId, count] of activityCounts.mentionsByStream) {
          mentionCounts[streamId] = count
        }
        for (const [streamId, count] of activityCounts.totalByStream) {
          activityCountsPerStream[streamId] = count
        }
      }

      const commands = commandAvailabilityService.listWorkspaceCommands()

      // Compute muted stream IDs: streams where effective notification level is "muted".
      // Uses explicit level + stream-type default (no ancestor inheritance — acceptable
      // approximation for bootstrap since ancestor-inherited mutes are rare).
      const streamTypeMap = new Map(resolvedStreams.map((s) => [s.id, s.type]))
      const mutedStreamIds = streamMemberships
        .filter((m) => {
          const type = streamTypeMap.get(m.streamId)
          return type && getEffectiveLevel(m.notificationLevel, type) === "muted"
        })
        .map((m) => m.streamId)

      // The WorkOS JWT carries `permissions` once authz rollout is active.
      // Distinguish "claim absent" (older tokens / OAuth callback path) from
      // "claim present but empty" — only the former triggers the role-derived
      // fallback. An empty array means WorkOS deliberately granted nothing,
      // and falling back would silently escalate privilege.
      const userRole = req.user!.role
      const rawPermissions = req.authUser!.permissions
      const viewerPermissions: WorkspacePermissionSlug[] =
        rawPermissions === null ? permissionsForRole(userRole) : parseJwtPermissions(rawPermissions)

      const invitations = viewerPermissions.includes(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)
        ? await invitationService.listInvitations(workspaceId)
        : undefined

      res.json({
        data: {
          workspace,
          users,
          streams: resolvedStreams,
          streamMemberships,
          personas,
          bots: bots.map(serializeBot),
          emojis: getEmojiList(),
          emojiWeights,
          commands,
          unreadCounts,
          messageCounts,
          mentionCounts,
          activityCounts: activityCountsPerStream,
          unreadActivityCount: activityCounts?.total ?? 0,
          mutedStreamIds,
          dmPeers,
          userPreferences,
          workspaceSettings,
          featureFlags,
          sidebarConfig,
          labels,
          labelMemberships,
          labelAssignments,
          invitations,
          viewerPermissions,
        },
      })
    },

    async markAllAsRead(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const updatedStreamIds = await streamService.markAllAsRead(workspaceId, userId)

      // Clear all mention badges
      await activityService?.markAllAsRead(userId, workspaceId)

      res.json({ updatedStreamIds })
    },

    async completeUserSetup(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = completeUserSetupSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const user = await workspaceService.completeUserSetup(userId, workspaceId, result.data)

      res.json({ user })
    },

    async checkSlugAvailability(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id

      const result = checkSlugAvailableSchema.safeParse(req.query)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const available = await workspaceService.isSlugAvailable(workspaceId, result.data.slug, userId)
      res.json({ available })
    },

    async updateProfile(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = updateProfileSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const user = await workspaceService.updateUserProfile(userId, workspaceId, result.data)
      res.json({ user })
    },

    async setStatus(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = setStatusSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const user = await workspaceService.setUserStatus(userId, workspaceId, {
        statusEmoji: result.data.emoji,
        statusText: result.data.text,
        statusExpiresAt: result.data.expiresAt ? new Date(result.data.expiresAt) : null,
        statusPausesNotifications: result.data.pausesNotifications,
      })
      res.json({ user })
    },

    async clearStatus(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const user = await workspaceService.setUserStatus(userId, workspaceId, {
        statusEmoji: null,
        statusText: null,
        statusExpiresAt: null,
        statusPausesNotifications: false,
      })
      res.json({ user })
    },

    async pauseNotifications(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = setNotificationPauseSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const user = await workspaceService.setNotificationPause(userId, workspaceId, {
        until: result.data.until ? new Date(result.data.until) : null,
      })
      res.json({ user })
    },

    async resumeNotifications(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const user = await workspaceService.clearNotificationPause(userId, workspaceId)
      res.json({ user })
    },

    async uploadAvatar(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      if (!req.file?.buffer) {
        return res.status(400).json({ error: "No file uploaded" })
      }

      const user = await workspaceService.uploadAvatar(userId, workspaceId, req.file.buffer)
      res.json({ user })
    },

    async removeAvatar(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const user = await workspaceService.removeUserAvatar(userId, workspaceId)
      res.json({ user })
    },

    async serveAvatarFile(req: Request, res: Response) {
      const { workspaceId, userId, file } = req.params
      if (!workspaceId || !userId || !file) {
        return res.status(404).end()
      }

      try {
        const stream = await avatarService.streamAvatarFile({ workspaceId, userId, file })
        if (!stream) return res.status(404).end()

        res.set("Content-Type", "image/webp")
        res.set("Cache-Control", "public, max-age=31536000, immutable")
        stream.on("error", () => {
          if (!res.headersSent) {
            res.status(500).end()
          } else {
            res.end()
          }
        })
        stream.pipe(res)
      } catch {
        res.status(404).end()
      }
    },
  }
}
