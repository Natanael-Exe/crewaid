/** AG-UI custom event name emitted during a running `code_task` for live progress UI. */
export const CODING_PROGRESS_EVENT = 'crewaid.code_task.progress' as const;

export type CodingTaskProgress = {
  readonly toolCallId: string;
  readonly kind: 'started' | 'step' | 'waiting_local_permission' | 'resumed' | 'finished';
  readonly step: number;
  readonly maxSteps: number;
  readonly modelLabel?: string;
  /** The inner tool this step runs; the desktop titles it in the user's language. */
  readonly toolName?: string;
  /** What the step acts on, already shortened by the server (a basename, a pattern, a command). */
  readonly target?: string;
  /** The server's English description, used only when `toolName` is missing. */
  readonly action?: string;
  readonly file?: string;
  readonly status?: string;
  readonly connectorName?: string;
  readonly permissionToolCallId?: string;
  readonly title?: string;
  readonly toolKind?: string;
  readonly outcome?: 'selected' | 'cancelled';
  readonly filesChangedCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a `crewaid.code_task.progress` AG-UI CUSTOM event payload defensively. */
export function parseCodingProgress(
  eventName: unknown,
  value: unknown,
): CodingTaskProgress | undefined {
  if (eventName !== CODING_PROGRESS_EVENT || !isRecord(value)) return undefined;
  const toolCallId = value['toolCallId'];
  const kind = value['kind'];
  const step = value['step'];
  const maxSteps = value['maxSteps'];
  if (
    typeof toolCallId !== 'string' ||
    toolCallId === '' ||
    (kind !== 'started' &&
      kind !== 'step' &&
      kind !== 'waiting_local_permission' &&
      kind !== 'resumed' &&
      kind !== 'finished') ||
    typeof step !== 'number' ||
    !Number.isFinite(step) ||
    typeof maxSteps !== 'number' ||
    !Number.isFinite(maxSteps)
  ) {
    return undefined;
  }
  const modelLabel = typeof value['modelLabel'] === 'string' ? value['modelLabel'] : undefined;
  const toolName = typeof value['toolName'] === 'string' ? value['toolName'] : undefined;
  const target = typeof value['target'] === 'string' ? value['target'] : undefined;
  const action = typeof value['action'] === 'string' ? value['action'] : undefined;
  const file = typeof value['file'] === 'string' ? value['file'] : undefined;
  const status = typeof value['status'] === 'string' ? value['status'] : undefined;
  const connectorName =
    typeof value['connectorName'] === 'string' ? value['connectorName'] : undefined;
  const permissionToolCallId =
    typeof value['permissionToolCallId'] === 'string' ? value['permissionToolCallId'] : undefined;
  const title = typeof value['title'] === 'string' ? value['title'] : undefined;
  const toolKind = typeof value['toolKind'] === 'string' ? value['toolKind'] : undefined;
  const rawOutcome = value['outcome'];
  const outcome =
    rawOutcome === 'selected' || rawOutcome === 'cancelled' ? rawOutcome : undefined;
  const filesChangedCount =
    typeof value['filesChangedCount'] === 'number' && Number.isFinite(value['filesChangedCount'])
      ? value['filesChangedCount']
      : 0;

  return {
    toolCallId,
    kind,
    step,
    maxSteps,
    filesChangedCount,
    ...(modelLabel === undefined ? {} : { modelLabel }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(target === undefined ? {} : { target }),
    ...(action === undefined ? {} : { action }),
    ...(file === undefined ? {} : { file }),
    ...(status === undefined ? {} : { status }),
    ...(connectorName === undefined ? {} : { connectorName }),
    ...(permissionToolCallId === undefined ? {} : { permissionToolCallId }),
    ...(title === undefined ? {} : { title }),
    ...(toolKind === undefined ? {} : { toolKind }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}
