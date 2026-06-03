import { createBrowserRouter } from "react-router-dom"
import { ProtectedRoute } from "@/components/protected-route"
import { WelcomePage } from "@/pages/welcome"
import { InviteWorkspaceOwnerPage } from "@/pages/invite-workspace-owner"
import { WorkspacesPage } from "@/pages/workspaces"
import { WaitlistPage } from "@/pages/waitlist"
import { WorkspaceDetailLayout } from "@/pages/workspace-detail-layout"
import { WorkspaceDetailOverviewPage } from "@/pages/workspace-detail-overview"
import { WorkspaceDetailMembersPage } from "@/pages/workspace-detail-members"
import { NotAuthorizedPage } from "@/pages/not-authorized"

export const router = createBrowserRouter([
  {
    path: "/not-authorized",
    element: <NotAuthorizedPage />,
  },
  {
    path: "/",
    element: <ProtectedRoute />,
    children: [
      { index: true, element: <WelcomePage /> },
      { path: "workspaces", element: <WorkspacesPage /> },
      { path: "waitlist", element: <WaitlistPage /> },
      {
        path: "workspaces/:id",
        element: <WorkspaceDetailLayout />,
        children: [
          { index: true, element: <WorkspaceDetailOverviewPage /> },
          { path: "members", element: <WorkspaceDetailMembersPage /> },
        ],
      },
      { path: "invites/workspace-owners", element: <InviteWorkspaceOwnerPage /> },
    ],
  },
])
