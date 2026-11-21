/**
 * A person's bot lists their crew in Telegram's `/` menu, so `/emma`
 * reaches Emma. The control commands come after the crew and always win a
 * name clash: a crew member called "Stop" becomes `/stop_2`, never `/stop`.
 */
export const CONTROL_COMMANDS = [
  { command: 'bots', description: 'Choose who to talk to' },
  { command: 'new', description: 'Start a new topic with the selected crew member' },
  { command: 'status', description: 'What the selected crew member is doing' },
  { command: 'approvals', description: 'Decisions waiting for you' },
  { command: 'stop', description: 'Stop the selected crew member' },
  { command: 'help', description: 'How to use this bot' },
  { command: 'unlink', description: 'Disconnect this bot from Crewaid' },
] as const;

export type TelegramMenuEntry = { command: string; description: string };
export type CrewCommand = TelegramMenuEntry & { botId: string; name: string };

const CONTROL = new Set<string>(['start', ...CONTROL_COMMANDS.map((entry) => entry.command)]);
/** Telegram takes at most 100 commands. */
const MENU_LIMIT = 100;

export const isControlCommand = (command: string): boolean => CONTROL.has(command);

/** `Émma Rose` → `emma_rose`: lowercase ASCII letters, digits and underscores, ≤ 32. */
export function commandSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
}

/** One command per crew member, in the order given, unique and never a control command. */
export function crewCommands(
  bots: readonly { id: string; name: string; role: string }[],
): CrewCommand[] {
  const used = new Set(CONTROL);
  const commands: CrewCommand[] = [];
  for (const bot of bots) {
    if (commands.length >= MENU_LIMIT - CONTROL_COMMANDS.length) break;
    let base = commandSlug(bot.name) || 'crew';
    if (!/^[a-z]/.test(base)) base = `crew_${base}`.slice(0, 32);
    let command = base;
    for (let n = 2; used.has(command); n++) {
      const suffix = `_${n}`;
      command = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    }
    used.add(command);
    const role = bot.role.trim();
    commands.push({
      command,
      description: (role.length >= 3 ? role : `Talk to ${bot.name}`).slice(0, 256),
      botId: bot.id,
      name: bot.name,
    });
  }
  return commands;
}

export function telegramMenu(crew: readonly CrewCommand[]): TelegramMenuEntry[] {
  return [
    ...crew.map(({ command, description }) => ({ command, description })),
    ...CONTROL_COMMANDS,
  ];
}
