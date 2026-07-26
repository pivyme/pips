import { createFileRoute } from '@tanstack/react-router'

import { PerfPage } from '@/admin/pages'

export const Route = createFileRoute('/admin/perf')({ component: PerfPage })
