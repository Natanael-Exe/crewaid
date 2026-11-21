import type { ReactNode } from 'react';

/**
 * The frame every screen before the shell sits in: sign-in, then (on a hosted
 * build) choosing a plan. The room's wallpaper with one glass card on it — the
 * shell's look without the shell, whose panes cannot do anything yet.
 */
export function GateFrame({
  children,
  width = 'narrow',
}: {
  readonly children: ReactNode;
  /** `narrow` for a single column of fields, `wide` for plans side by side. */
  readonly width?: 'narrow' | 'wide';
}) {
  return (
    <div className="crewaid-gate">
      {/* Without a drag strip this screen pins the window in place: the shell's
          own title bars are behind the gate, and Electron's frame is hidden. */}
      <div className="window-drag h-12 w-full shrink-0" />
      <main className="flex flex-1 overflow-y-auto px-6 pb-12">
        <div
          className={`crewaid-gate-card m-auto ${width === 'wide' ? 'max-w-[680px]' : 'max-w-[440px]'}`}
        >
          {children}
        </div>
      </main>
    </div>
  );
}
