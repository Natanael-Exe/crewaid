export type {
  AcpByteTransport,
  AcpCommandRecord,
  AcpHarnessId,
  AcpPermissionDecision,
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionRequest,
  AcpProgressUpdate,
  AcpReportMode,
  AcpRunInput,
  AcpRunOutput,
  AcpSessionStatus,
} from './types.js';

export {
  computeLocalTaskPayloadHash,
  normalizeRelativeCwd,
  type LocalTaskHashInput,
} from './payload-hash.js';

export {
  assertSupportedNodeVersion,
  BUILTIN_ACP_HARNESS_IDS,
  BUILTIN_ACP_HARNESSES,
  detectInstalledHarnesses,
  findExecutableOnPath,
  parseCommandLine,
  resolveHarnessCommand,
  type BuiltinAcpHarnessId,
  type AcpHarnessPreset,
  type DetectedHarness,
  type DetectHarnessesOptions,
  type ResolvedHarnessCommand,
} from './harnesses.js';

export {
  formatDiffExcerpt,
  MAX_DIFF_EXCERPT_CHARS,
  MAX_SINGLE_DIFF_CHARS,
  MAX_STEP_TITLE_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_ONLY_CHARS,
  CODE_OMITTED_MARKER,
  boundSummary,
  MAX_TRANSCRIPT_EXCERPT_CHARS,
  relativizeReportedPath,
  sanitizeOneLine,
  truncateText,
} from './privacy.js';

export { AcpSessionProjector, mapToolKindToName } from './projector.js';

export { createChildProcessTransport, createNodeStreamTransport, runAcpSession } from './client.js';
