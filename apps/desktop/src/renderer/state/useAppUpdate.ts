import { useEffect, useState } from 'react';
import type { UpdateState } from '../../preload';
import { appUpdate } from '../bridge';

/**
 * The app's update state, kept current by the main process.
 *
 * Subscribes before the first read, for the reason the launch gate does: an
 * update that finishes downloading while this mounts would otherwise land in
 * the gap between the two and the button would not appear until the next one.
 */
export function useAppUpdate(): UpdateState {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  useEffect(() => {
    let live = true;
    const unsubscribe = appUpdate.onChanged((next) => {
      if (live) setState(next);
    });
    void appUpdate.state().then((current) => {
      if (live) setState(current);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return state;
}
