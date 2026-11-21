import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_AUTO_REVIEW_RULES,
  templateMatches,
  type Locale,
  type Template,
  type TemplateInstallBody,
} from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { TurnEventBus } from '../agent/turn-event.bus.js';
import { USER_PREFERENCES_SELECT, writingLanguage } from '../providers/user-preferences.js';
import { templateCatalog } from './template-catalog.js';

/** "Hannah", then "Hannah 2": a second copy of a crew must stay addressable by name. */
function unusedName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/**
 * What a crew's members read every turn (D-131 group instructions). Roles map
 * to bot ids because a person may rename anyone afterwards; an id survives
 * that, a name does not.
 */
function crewBrief(
  template: Template,
  input: TemplateInstallBody,
  members: readonly { role: string; name: string; id: string }[],
): string {
  return [
    `Goal: ${input.goal.trim() || template.summary}`,
    input.context.trim() === '' ? '' : `Shared context from the user:\n${input.context.trim()}`,
    `Who does what (reach a teammate with send_message by id):\n${members
      .map((member) => `- ${member.role}: ${member.name} (${member.id})`)
      .join('\n')}`,
    `How work usually moves: ${template.handoff.join(' → ')}.`,
    'Hand work on with send_message, and when a teammate asks you for something, reply to that teammate with the result and where you saved it. Nothing starts because a task or file appeared. If someone in this list is no longer on the team, say so rather than handing their part to someone else.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

@Injectable()
export class TemplateService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TurnEventBus) private readonly events: TurnEventBus,
  ) {}

  /**
   * D-235: the language the person reads templates in. A run already knows it
   * and passes it; this is for a request that arrives on its own.
   */
  async languageOf(userId: string): Promise<Locale | null> {
    const settings = await this.prisma.userSettings.findFirst({
      where: { userId },
      select: USER_PREFERENCES_SELECT,
    });
    return writingLanguage(settings);
  }

  list(query: string, language: Locale | null): Template[] {
    return templateCatalog(language).filter((entry) => templateMatches(entry, query));
  }

  read(id: string, language: Locale | null): Template {
    const found = templateCatalog(language).find((entry) => entry.id === id);
    if (!found) throw new NotFoundException('Template not found.');
    return found;
  }

  /** The definition plus the caller's own connections and earlier installs of it. */
  async readForUser(userId: string, id: string, language: Locale | null): Promise<Template> {
    const template = this.read(id, language);
    const [connections, installations] = await Promise.all([
      this.prisma.mcpServer.findMany({
        where: { userId },
        select: { id: true, slug: true, name: true, status: true, accessMode: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.templateInstallation.findMany({
        where: { userId, templateId: id },
        select: { id: true, groupId: true, botIds: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
    ]);
    const members = await this.prisma.bot.findMany({
      where: { userId, id: { in: installations.flatMap((entry) => entry.botIds) } },
      select: { id: true, name: true, role: true },
    });
    return {
      ...template,
      connections,
      installations: installations.map((entry) => ({
        ...entry,
        members: members.filter((bot) => entry.botIds.includes(bot.id)),
      })),
    };
  }

  /**
   * Add a reviewed template: its group, bots, conversations and brief commit
   * together or not at all. The idempotency key makes a retry return the
   * first result; reusing it for a different setup is refused.
   */
  async install(userId: string, input: TemplateInstallBody, language: Locale | null) {
    const template = this.read(input.templateId, language);
    if (template.revision !== input.revision)
      throw new ConflictException(
        'This template changed. Review the latest version before adding it.',
      );
    const serverIds = [...new Set(input.serverIds)].sort();
    const configuration = JSON.stringify({
      templateId: input.templateId,
      revision: input.revision,
      goal: input.goal,
      context: input.context,
      serverIds,
    });
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
        const previous = await tx.templateInstallation.findFirst({
          where: { userId, idempotencyKey: input.idempotencyKey },
        });
        if (previous) {
          if (previous.configuration !== configuration)
            throw new ConflictException(
              'This setup request was already used for a different configuration.',
            );
          return { installation: previous, created: false };
        }
        const servers = await tx.mcpServer.findMany({
          where: { userId, id: { in: serverIds } },
          select: { id: true, slug: true },
        });
        if (servers.length !== serverIds.length)
          throw new NotFoundException('A selected connection is no longer available.');
        // Joins the user's computer if there is one. Provisioning one is left to
        // the first turn that needs it (SandboxWorkspaceService.ensure), so
        // adding a crew never starts a machine.
        const computer = await tx.sandbox.findFirst({
          where: { userId },
          orderBy: { id: 'asc' },
          select: { id: true },
        });
        const existingBots = await tx.bot.findMany({ where: { userId }, select: { name: true } });
        const existingGroups = await tx.botGroup.findMany({
          where: { userId },
          select: { name: true },
        });
        const takenNames = new Set(existingBots.map((bot) => bot.name));
        const group =
          template.kind === 'crew'
            ? await tx.botGroup.create({
                data: {
                  userId,
                  name: unusedName(template.title, new Set(existingGroups.map((g) => g.name))),
                  instructions: '',
                },
              })
            : null;
        const members: { role: string; name: string; id: string }[] = [];
        for (const profile of template.bots) {
          const name = unusedName(profile.name, takenNames);
          takenNames.add(name);
          const brief =
            template.kind === 'bot' && (input.goal.trim() || input.context.trim())
              ? `\n\nBrief from the user:\n${[input.goal.trim(), input.context.trim()].filter(Boolean).join('\n')}`
              : '';
          const bot = await tx.bot.create({
            data: {
              userId,
              name,
              role: profile.role,
              systemPrompt: `${profile.systemPrompt}${brief}`,
              avatarColor: profile.avatarColor,
              avatarShape: profile.avatarShape,
              modelId: 'default',
              autoReviewRules: DEFAULT_AUTO_REVIEW_RULES,
              groupId: group?.id ?? null,
              sandboxId: computer?.id ?? null,
            },
          });
          await tx.conversation.create({ data: { botId: bot.id } });
          members.push({ role: bot.role, name: bot.name, id: bot.id });
          // A selected tool is granted to the members whose definition lists it.
          for (const server of servers)
            if (profile.toolSlugs.some((slug) => normalized(slug) === normalized(server.slug)))
              await tx.botMcpServer.create({
                data: { botId: bot.id, serverId: server.id, enabled: true },
              });
        }
        if (group)
          await tx.botGroup.update({
            where: { id: group.id, userId },
            data: { instructions: crewBrief(template, input, members) },
          });
        const installation = await tx.templateInstallation.create({
          data: {
            userId,
            idempotencyKey: input.idempotencyKey,
            templateId: template.id,
            revision: template.revision,
            configuration,
            groupId: group?.id ?? null,
            botIds: members.map((member) => member.id),
          },
        });
        return { installation, created: true };
      },
      { timeout: 30_000 },
    );
    // Announced only after commit; a lost notice is recovered by the next roster read.
    if (result.created)
      for (const id of result.installation.botIds) {
        try {
          this.events.emitBotsChanged(userId, id, 'created');
        } catch {
          /* The roster read on reconnect carries what this notice would have. */
        }
      }
    return result.installation;
  }
}

function normalized(slug: string): string {
  return slug.toLowerCase().replace(/[-_]/g, '');
}
