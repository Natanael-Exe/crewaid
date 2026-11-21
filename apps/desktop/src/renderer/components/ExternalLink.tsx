import type { ReactNode } from 'react';
import { systemBrowser } from '../bridge';

const OPENABLE_LINK = /^https:\/\//i;

/** Whether `ExternalLink` draws this as a link at all. */
export function isOpenableLink(href: string | null | undefined): href is string {
  return href !== null && href !== undefined && OPENABLE_LINK.test(href);
}

/**
 * A link that leaves the app. A click goes to the system browser through the
 * main process's fenced `openExternal`, which accepts https only — so that is
 * the only link drawn as one. `target=_blank` alone would open an Electron
 * window on the page, and a bot-written URL is not one to trust with a scheme.
 * Anything else keeps its text and loses its target.
 */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string | null | undefined;
  className?: string;
  children?: ReactNode;
}) {
  if (!isOpenableLink(href)) return <span data-link-blocked>{children}</span>;
  return (
    <a
      href={href}
      rel="noreferrer"
      className={className}
      onClick={(event) => {
        event.preventDefault();
        void systemBrowser.open(href);
      }}
      onAuxClick={(event) => event.preventDefault()}
    >
      {children}
    </a>
  );
}
