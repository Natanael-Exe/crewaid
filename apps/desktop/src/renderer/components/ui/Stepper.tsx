import { IconCheck } from '@tabler/icons-react';
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type ComponentPropsWithRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cx } from './compose';

/**
 * A row of numbered steps joined by lines. Steps before `currentStep` are
 * done (a check on the accent), the current one is outlined, later ones are
 * faint. With `onStepChange` every step is a button back to that point.
 */

type StepStatus = 'complete' | 'active' | 'inactive';

const StepperContext = createContext<{
  readonly currentStep: number;
  readonly onStepChange?: (step: number) => void;
}>({ currentStep: 0 });

const StepContext = createContext<{
  readonly index: number;
  readonly isLast: boolean;
  readonly status: StepStatus;
}>({ index: 0, isLast: false, status: 'inactive' });

export interface StepperRootProps extends ComponentPropsWithRef<'ol'> {
  readonly currentStep: number;
  readonly onStepChange?: (step: number) => void;
}

export function StepperRoot({
  children,
  className,
  currentStep,
  onStepChange,
  ...props
}: StepperRootProps) {
  // Each step learns its own index and whether it is last, so the screen can
  // write steps as plain children.
  const steps = Children.toArray(children).filter(
    (child): child is ReactElement<StepperStepProps> =>
      isValidElement(child) && child.type === StepperStep,
  );
  return (
    <StepperContext
      value={{ currentStep, ...(onStepChange !== undefined ? { onStepChange } : {}) }}
    >
      <ol data-slot="stepper" className={cx('flex w-full items-start', className)} {...props}>
        {steps.map((step, index) =>
          cloneElement(step, { stepIndex: index, isLast: index === steps.length - 1 }),
        )}
      </ol>
    </StepperContext>
  );
}

export interface StepperStepProps extends ComponentPropsWithRef<'li'> {
  readonly stepIndex?: number;
  readonly isLast?: boolean;
}

export function StepperStep({
  children,
  className,
  isLast = false,
  stepIndex = 0,
  ...props
}: StepperStepProps) {
  const { currentStep, onStepChange } = useContext(StepperContext);
  const status: StepStatus =
    stepIndex < currentStep ? 'complete' : stepIndex === currentStep ? 'active' : 'inactive';
  const parts: ReactNode[] = [];
  let separator: ReactNode = null;
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.type === StepperSeparator) separator = child;
    else parts.push(child);
  });
  const clickable = onStepChange !== undefined;
  return (
    <StepContext value={{ index: stepIndex, isLast, status }}>
      <li
        data-slot="stepper-step"
        data-status={status}
        // The last step takes its own width but may still give some back: a
        // translated title can be far longer than the English one, and a step
        // that cannot shrink pushes its title over its neighbours'.
        className={cx('flex min-w-0 items-start', isLast ? 'flex-initial' : 'flex-1', className)}
        {...props}
      >
        {clickable ? (
          <button
            type="button"
            data-slot="stepper-step-button"
            aria-current={status === 'active' ? 'step' : undefined}
            onClick={() => onStepChange(stepIndex)}
            className="flex min-w-0 cursor-[var(--cursor-interactive)] flex-col items-center gap-1.5 rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {parts}
          </button>
        ) : (
          <div
            data-slot="stepper-step-header"
            aria-current={status === 'active' ? 'step' : undefined}
            className="flex min-w-0 flex-col items-center gap-1.5"
          >
            {parts}
          </div>
        )}
        {separator}
      </li>
    </StepContext>
  );
}

const indicatorTone: Record<StepStatus, string> = {
  complete: 'border-transparent bg-accent text-accent-foreground',
  active: 'border-foreground text-foreground',
  inactive: 'border-border text-foreground-faint',
};

export function StepperIndicator({ children, className, ...props }: ComponentPropsWithRef<'span'>) {
  const { index, status } = useContext(StepContext);
  return (
    <span
      data-slot="stepper-indicator"
      data-status={status}
      className={cx(
        'grid size-6 shrink-0 place-items-center rounded-full border text-caption font-medium tabular-nums',
        indicatorTone[status],
        className,
      )}
      {...props}
    >
      {children ??
        (status === 'complete' ? (
          <IconCheck className="size-3.5" stroke={2.5} aria-hidden />
        ) : (
          index + 1
        ))}
    </span>
  );
}

export function StepperTitle({ className, ...props }: ComponentPropsWithRef<'span'>) {
  const { status } = useContext(StepContext);
  return (
    <span
      data-slot="stepper-title"
      className={cx(
        // Wraps rather than overflowing into the next step's title.
        'max-w-full text-balance break-words text-center text-caption',
        status === 'inactive' ? 'text-muted' : 'text-foreground',
        status === 'active' && 'font-medium',
        className,
      )}
      {...props}
    />
  );
}

export function StepperSeparator({ className, ...props }: ComponentPropsWithRef<'div'>) {
  const { isLast, status } = useContext(StepContext);
  if (isLast) return null;
  return (
    <div
      aria-hidden
      data-slot="stepper-separator"
      data-complete={status === 'complete' || undefined}
      className={cx(
        // Centred on the 24px indicator beside it.
        'mx-2 mt-3 h-px min-w-4 flex-1 rounded-full',
        status === 'complete' ? 'bg-accent' : 'bg-border',
        className,
      )}
      {...props}
    />
  );
}

export const Stepper = Object.assign(StepperRoot, {
  Root: StepperRoot,
  Step: StepperStep,
  Indicator: StepperIndicator,
  Title: StepperTitle,
  Separator: StepperSeparator,
});
