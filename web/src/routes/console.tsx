import { createFileRoute } from '@tanstack/react-router'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'

export const Route = createFileRoute('/console')({ component: ConsoleCanvas })
