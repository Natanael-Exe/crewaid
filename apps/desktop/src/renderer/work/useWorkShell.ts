import { useCallback, useEffect, useState } from 'react';
import type { ProjectWithCounts } from '@crewaid/shared';
import { failureOf, type ApiFailure } from '../api';
import type { ApiClient } from '../api/apiClient';
import { listProjects, listTasks } from '../api/work';
import type { WorkRevisions } from '../state/chatReducer';
import { attentionCount } from './workState';

/**
 * What every Work view and the sidebar share: the user's projects and the
 * Tasks badge. Re-read whenever a `*.changed` frame moves the revision they
 * depend on — the frames carry ids, never the numbers themselves.
 */
export function useWorkShell(client: ApiClient, revisions: WorkRevisions) {
  const [projects, setProjects] = useState<readonly ProjectWithCounts[]>([]);
  const [attention, setAttention] = useState(0);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    listProjects(client)
      .then((rows) => {
        if (!live) return;
        setProjects(rows);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (live) setFailure(failureOf(error));
      });
    return () => {
      live = false;
    };
  }, [client, revisions.projects, nonce]);

  useEffect(() => {
    let live = true;
    listTasks(client, { status: ['IN_REVIEW', 'BLOCKED'] })
      .then((cards) => {
        if (live) setAttention(attentionCount(cards));
      })
      // An older server has no /tasks: the badge simply stays quiet.
      .catch(() => {
        if (live) setAttention(0);
      });
    return () => {
      live = false;
    };
  }, [client, revisions.tasks]);

  const reloadProjects = useCallback(() => setNonce((value) => value + 1), []);
  return { projects, attention, failure, reloadProjects };
}
