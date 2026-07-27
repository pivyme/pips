import { Modal as HeroModal, useOverlayState } from '@heroui/react'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

type ModalSize = 'xs' | 'sm' | 'md' | 'lg' | 'cover' | 'full'
type ModalPlacement = 'auto' | 'center' | 'top' | 'bottom'
type BackdropVariant = 'opaque' | 'blur' | 'transparent'
type ScrollBehavior = 'inside' | 'outside'

type ModalProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  size?: ModalSize
  placement?: ModalPlacement
  backdrop?: BackdropVariant
  scroll?: ScrollBehavior
  isDismissable?: boolean
  isKeyboardDismissDisabled?: boolean
  className?: string
  bodyClassName?: string
}

// Flat wrapper around HeroUI's Modal.Backdrop > Container > Dialog > Header/Body/Footer chain.
// Backdrop defaults to blur, not HeroUI's flat `opaque`: every hand-rolled overlay in the app (the
// achievement bloom, the celebrations) frosts what's behind it, and a modal that only dims reads cheap
// against them. The presenting curve is retuned in styles.css; stock is a barely-visible 5% shrink.
//
// Chrome is bottom-drawer style: the title + close row is `position: sticky` INSIDE the scrolling body
// (like MenuHeader), so content actually slides underneath it and fades into the gradient instead of
// getting hard-clipped at a seam. It's laid out in the same padded flow as the body content below it
// (not absolutely positioned against the unpadded dialog), so it can never land where the body's own
// scrollbar renders, which is what used to overlap HeroUI's default `.modal__close-trigger`.
export function Modal({
  isOpen,
  onOpenChange,
  title,
  description,
  footer,
  children,
  size = 'md',
  placement = 'center',
  backdrop = 'blur',
  scroll = 'inside',
  isDismissable = true,
  isKeyboardDismissDisabled,
  className,
  bodyClassName,
}: ModalProps) {
  return (
    <HeroModal.Backdrop
      variant={backdrop}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={isKeyboardDismissDisabled}
    >
      <HeroModal.Container size={size} placement={placement} scroll={scroll}>
        <HeroModal.Dialog className={cnm('!p-0 overflow-hidden border border-line bg-[#161615]', className)}>
          <HeroModal.Body className={cnm('min-h-0 flex-1 overflow-y-auto', bodyClassName)}>
            <div className="sticky top-0 z-10 flex items-start justify-between gap-3 bg-[linear-gradient(180deg,#161615_0%,#161615_60%,rgba(22,22,21,0)_100%)] px-6 pb-6 pt-6">
              <div className="min-w-0 flex-1">
                {title != null && (
                  <HeroModal.Heading className="text-[22px] font-black leading-none text-white">{title}</HeroModal.Heading>
                )}
                {description != null && <p className="mt-2 text-sm leading-snug text-text-3">{description}</p>}
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Close"
                className="-mr-2 -mt-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-white/70 transition-transform active:scale-90"
              >
                <X className="h-[18px] w-[18px]" strokeWidth={2.6} />
              </button>
            </div>
            {children != null && <div className="-mt-4 px-6 pb-6">{children}</div>}
          </HeroModal.Body>
          {footer != null && <HeroModal.Footer className="px-6 pb-6">{footer}</HeroModal.Footer>}
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  )
}

export { useOverlayState }
