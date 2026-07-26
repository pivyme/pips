import { createFileRoute } from '@tanstack/react-router'

import { UsagePage } from '@/admin/pages'

export const Route = createFileRoute('/admin/usage')({ component: UsagePage })
