// PROBE — MUST FAIL LINT. See docs/DECISIONS.md D-013.
// Rule: no-restricted-syntax · Guard: CC-07/V1-11 — one IPC fence
//
// This is the shape the rule exists to stop: a second channel registered
// beside the fenced ones, whose handler never looks at who sent the message.
// It is what `@better-auth/electron`'s own preload helper does, and it is two
// lines — which is exactly why it needs a machine to refuse it.
type IpcMainLike = {
  handle: (channel: string, handler: (event: unknown, value?: unknown) => unknown) => void;
};

declare const ipcMain: IpcMainLike;
declare const options: { ipcMain: IpcMainLike };

export const probe = (): void => {
  // Imported straight from electron, which is how it reads in main.ts.
  ipcMain.handle('crewaid:auth:start', (_event, value) => value);
  // Passed through a port, which is how `guardedIpc` reaches it — and so the
  // shape a second registrar would copy while looking like it belonged.
  options.ipcMain.handle('crewaid:auth:signOut', (_event, value) => value);
};
