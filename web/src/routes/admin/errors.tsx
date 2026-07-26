import { createFileRoute } from '@tanstack/react-router'

import { ErrorsPage } from '@/admin/ErrorsPage'

export const Route = createFileRoute('/admin/errors')({ component: ErrorsPage })
