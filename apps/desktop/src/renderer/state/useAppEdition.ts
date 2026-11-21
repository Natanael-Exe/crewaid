import { useEffect, useState } from 'react';
import type { Edition } from '@crewaid/shared';
import { appInfo } from '../bridge';

/**
 * Asked once per renderer: the edition is fixed when the app is built, so a
 * second answer could only ever repeat the first.
 */
let pending: Promise<Edition | null> | undefined;

/**
 * This build's edition, `null` until the main process has answered.
 *
 * Components render neither edition's extras while it is `null` — see
 * `appInfo.edition` for why there is no default to fall back on.
 */
export function useAppEdition(): Edition | null {
  const [edition, setEdition] = useState<Edition | null>(null);
  useEffect(() => {
    let live = true;
    pending ??= appInfo.edition();
    void pending.then((value) => {
      if (live) setEdition(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return edition;
}
