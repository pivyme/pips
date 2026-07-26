import { createFileRoute } from '@tanstack/react-router'

import { OverviewPage } from '@/admin/pages'

export const Route = createFileRoute('/admin/')({ component: OverviewPage })
