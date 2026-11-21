/**
 * What the stream code logs through. Nest's `Logger` satisfies it in the
 * orchestrator; a plain console adapter does inside a computer, where there is
 * no Nest. Neither host is imported here, so this package runs in both.
 */
export interface ScreenLogger {
  log(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** For tests and callers that have nowhere to send a line. */
export const SILENT_SCREEN_LOGGER: ScreenLogger = {
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
};
