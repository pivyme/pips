// Layout route for the dashboard. A sibling of _app, never a child: _app boots the persistent 3D console
// and the dashboard must never load WebGL. Thin by design, everything real lives in src/admin/.

import { Outlet, createFileRoute } from '@tanstack/react-router'

import { AdminShell } from '@/admin/AdminShell'

export const Route = createFileRoute('/admin')({ component: AdminLayout })

function AdminLayout() {
  return (
    <AdminShell>
      <Outlet />
    </AdminShell>
  )
}
