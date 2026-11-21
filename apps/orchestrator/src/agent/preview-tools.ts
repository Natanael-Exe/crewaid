import { NativeToolInputs } from '@crewaid/shared';
import { tool } from './tool-contract.js';
import { OBSERVING_BUILTIN, type RegisteredTool } from './tool-registry.js';

/** The canonical call stores the draft; presenting it has no external side effect. */
export function previewTools(): RegisteredTool[] {
  return [
    {
      name: 'preview_email',
      behavior: OBSERVING_BUILTIN,
      build: () =>
        tool({
          description:
            'Show an email draft for review in chat. Does not save to a mailbox or send. Use for drafting; wait for the user before saving or sending.',
          inputSchema: NativeToolInputs.preview_email,
          execute: () => 'Email preview shown in chat. Not saved or sent.',
        }),
    },
  ];
}
