import { summarizeInput, truncateForDisplay } from './toolParts';
import { t } from '../../i18n/i18n';

/**
 * What a bot is asking for, in words the person answering already knows.
 *
 * `Nathan Bot wants to run attach_file` names an internal function and leaves
 * the reader to work out what agreeing to it means. The person on the other
 * end of this prompt did not write the tool registry: they know what
 * "attaching a file to this chat" is, and they are being asked to decide,
 * which is a decision about the ACT, not about its implementation.
 *
 * So the prompt asks in the first person — the bot is the one asking — and the
 * tool name, the arguments and the JSON stay available one disclosure away,
 * for the times when the act is not the whole question (`shell` is always one
 * of those, which is why its command is on the face of the card).
 *
 * The map is over the built-ins §6/M5 ships. Anything else — an M6 MCP tool,
 * a compiled skill — falls through to a sentence built from its own name,
 * which is the honest answer for a tool this build has never heard of and is
 * still a sentence rather than a function signature.
 */

export interface ToolAsk {
  /** The question, first person, ending in a question mark. */
  readonly question: string;
  /** The one value that decides the answer, or null when there is none. */
  readonly detail: string | null;
  /** True when `detail` is a command or code, so it renders monospaced. */
  readonly detailIsCode: boolean;
}

function argOf(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The last segment of a path — what a person calls the file. */
function basename(path: string): string {
  const parts = path.split('/').filter((segment) => segment !== '');
  return parts[parts.length - 1] ?? path;
}

/** The site, not the URL: `kreova.co`, not 800 characters of query string. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A tool nobody registered a sentence for, as a sentence anyway.
 *
 * `browser_click` → "use my browser click tool". Underscores are what the
 * model sees; a person should not have to.
 */
function fallbackQuestion(toolName: string): string {
  const words = toolName.replace(/[_-]+/g, ' ').trim();
  return t('tools.ask.fallback', { tool: words });
}

export function describeToolAsk(toolName: string, args: unknown): ToolAsk {
  const plain = (question: string, detail: string | null = null): ToolAsk => ({
    question,
    detail,
    detailIsCode: false,
  });

  switch (toolName) {
    case 'shell': {
      const command = argOf(args, 'command');
      return {
        question: t('tools.ask.shell'),
        detail: command ?? null,
        // The command is the decision. Everything else about `shell` is
        // detail; this is not.
        detailIsCode: true,
      };
    }
    case 'code_task': {
      const goal = argOf(args, 'goal');
      const cwd = argOf(args, 'cwd');
      return plain(
        cwd === undefined
          ? t('tools.ask.codeTask')
          : t('tools.ask.codeTaskIn', { dir: basename(cwd) }),
        goal === undefined ? null : truncateForDisplay(goal, 240),
      );
    }
    case 'list_local_connectors':
      return plain(t('tools.ask.listLocalConnectors'));
    case 'local_code_task':
      // ApprovalPrompt renders the dedicated bound-proposal card with target
      // connector, folder, harness, hash prefix, and the full untruncated prompt.
      return plain(t('tools.ask.localCodeTask'));
    case 'process_start': {
      const command = argOf(args, 'command');
      const rawSec =
        typeof args === 'object' && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)['maxDurationSec']
          : undefined;
      const secs = typeof rawSec === 'number' && Number.isFinite(rawSec) ? rawSec : 1800;
      const limit =
        secs < 60
          ? `${Math.round(secs)}s`
          : secs % 60 === 0
            ? `${Math.round(secs / 60)}m`
            : `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
      return {
        question: t('tools.ask.processStart', { limit }),
        detail: command ?? null,
        detailIsCode: true,
      };
    }
    case 'process_output':
      return plain(t('tools.ask.processOutput'), argOf(args, 'processId') ?? null);
    case 'process_stop':
      return plain(t('tools.ask.processStop'), argOf(args, 'processId') ?? null);
    case 'fs_write': {
      const path = argOf(args, 'path');
      return plain(
        path === undefined ? t('tools.ask.saveFile') : t('tools.ask.saveThisFile'),
        path === undefined ? null : basename(path),
      );
    }
    case 'fs_read': {
      const path = argOf(args, 'path');
      return plain(t('tools.ask.readFile'), path === undefined ? null : basename(path));
    }
    case 'fs_edit': {
      const path = argOf(args, 'path');
      return plain(
        path === undefined ? t('tools.ask.editFile') : t('tools.ask.editThisFile'),
        path === undefined ? null : basename(path),
      );
    }
    case 'fs_grep': {
      const pattern = argOf(args, 'pattern');
      return {
        question: t('tools.ask.searchFiles'),
        detail: pattern ?? null,
        detailIsCode: pattern !== undefined,
      };
    }
    case 'fs_glob': {
      const pattern = argOf(args, 'pattern');
      return {
        question: t('tools.ask.findFiles'),
        detail: pattern ?? null,
        detailIsCode: pattern !== undefined,
      };
    }
    case 'attach_file': {
      const path = argOf(args, 'path');
      return plain(t('tools.ask.attachFile'), path === undefined ? null : basename(path));
    }
    case 'browser_navigate': {
      const url = argOf(args, 'url');
      return plain(
        url === undefined ? t('tools.ask.openPage') : t('tools.ask.openSite', { site: host(url) }),
        url ?? null,
      );
    }
    case 'browser_click':
      return plain(t('tools.ask.click'), argOf(args, 'selector') ?? null);
    case 'browser_type':
      return plain(t('tools.ask.type'), argOf(args, 'text') ?? null);
    case 'browser_read':
      return plain(t('tools.ask.readPage'));
    case 'screenshot':
      return plain(t('tools.ask.screenshot'));
    case 'remember':
      return plain(t('tools.ask.remember'), argOf(args, 'fact') ?? null);
    case 'forget':
      return plain(t('tools.ask.forget'), argOf(args, 'fact') ?? null);
    case 'memory_read':
    case 'memory_search':
      return plain(t('tools.ask.memory'), argOf(args, 'query') ?? null);
    case 'board_read':
      return plain(t('tools.ask.boardRead'));
    case 'board_add':
      return plain(t('tools.ask.boardAdd'), argOf(args, 'text') ?? argOf(args, 'title') ?? null);
    case 'board_update':
      return plain(t('tools.ask.boardUpdate'), argOf(args, 'text') ?? argOf(args, 'id') ?? null);
    case 'run_skill': {
      const name = argOf(args, 'name') ?? argOf(args, 'skillId');
      return plain(
        name === undefined ? t('tools.ask.runSkill') : t('tools.ask.runNamedSkill', { name }),
      );
    }
    case 'save_skill': {
      // The question names the skill; the SCRIPT is the substance of this
      // ask, and the card gives it its own block in full (ApprovalPrompt) —
      // a one-line summary here would be a summary of the thing being
      // approved.
      const name = argOf(args, 'name');
      return plain(
        name === undefined ? t('tools.ask.saveSkill') : t('tools.ask.saveNamedSkill', { name }),
      );
    }
    case 'send_message': {
      const to = argOf(args, 'botName') ?? argOf(args, 'botId');
      return plain(
        to === undefined ? t('tools.ask.message') : t('tools.ask.messageNamed', { to }),
        argOf(args, 'content') ?? null,
      );
    }
    case 'schedule_routine': {
      // The question a person should answer: this commits them to runs they
      // will not be watching. The prompt is the substance, so it is the detail.
      const name = argOf(args, 'name');
      const cron = argOf(args, 'cron');
      return plain(
        name === undefined
          ? cron === undefined
            ? t('tools.ask.schedule')
            : t('tools.ask.scheduleCron', { cron })
          : cron === undefined
            ? t('tools.ask.scheduleNamed', { name })
            : t('tools.ask.scheduleNamedCron', { name, cron }),
        argOf(args, 'prompt') ?? null,
      );
    }
    case 'cancel_routine': {
      const routine = argOf(args, 'routine');
      return plain(
        routine === undefined
          ? t('tools.ask.cancelRoutine')
          : t('tools.ask.cancelNamedRoutine', { routine }),
      );
    }
    case 'use_identity': {
      const name = argOf(args, 'identity') ?? argOf(args, 'name');
      return plain(
        name === undefined ? t('tools.ask.identity') : t('tools.ask.identityNamed', { name }),
      );
    }
    default:
      // The arguments summarized, because for an unknown tool they are the
      // only thing that says what the act touches.
      return plain(fallbackQuestion(toolName), summarizeInput(args, 160) || null);
  }
}
