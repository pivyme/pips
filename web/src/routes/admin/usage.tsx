import { createFileRoute } from '@tanstack/react-router'

import { UsagePage } from '@/admin/UsagePage'

export const Route = createFileRoute('/admin/usage')({ component: UsagePage })
