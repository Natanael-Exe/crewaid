import { resumeServerSentEventsResponse } from '@tanstack/ai';
import type { createRunEventLog } from './run-event-log.js';

/**
 * The library's own SSE encoding of a run's log: replay after the log's
 * `resumeFrom` offset, then tail, each frame tagged `id: <offset>` so the
 * stock client resumes with `Last-Event-ID`. `X-Accel-Buffering: no` keeps a
 * reverse proxy from holding frames back.
 */
export function runEventSseResponse(log: ReturnType<typeof createRunEventLog>): Response {
  return resumeServerSentEventsResponse({
    adapter: log,
    headers: { 'X-Accel-Buffering': 'no' },
  });
}
