import { z } from 'zod';
import { GitBranchSchema, GitHubRepositorySchema, JsonSchema, type Json } from '@crewaid/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { McpServersService } from '../../mcp/mcp-servers.service.js';
import type { RegisteredTool } from '../../agent/tool-registry.js';
import { policyHash, type CommitAdapter } from '../../agent/policy/policy.js';

const Identity = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  login: z.string().regex(/^[A-Za-z0-9-]+$/),
});
const Input = z.object({ owner: z.string(), repo: z.string() });
const ForkInput = Input.extend({
  name: z.string().optional(),
  organization: z.string().optional(),
});
const PullInput = Input.extend({
  head: z.string(),
  base: GitBranchSchema,
  title: z.string(),
  body: z.string().optional(),
  draft: z.boolean(),
});
const Fork = z.object({
  id: z.number(),
  full_name: GitHubRepositorySchema,
  fork: z.boolean(),
  owner: z.object({ id: z.number() }),
  source: z.object({ id: z.number() }).optional(),
  parent: z.object({ id: z.number() }).optional(),
});
const Pulls = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    draft: z.boolean(),
    user: z.object({ id: z.number() }),
    head: z.object({ label: z.string() }),
    base: z.object({ ref: z.string() }),
  }),
);

/** A remote write stays the existing MCP method; recovery uses fixed, read-only REST routes. */
export function bindGitHubWrite(
  tool: RegisteredTool,
  prisma: PrismaService,
  servers: McpServersService,
  userId: string,
  botId: string,
  serverId: string,
  name: string,
): RegisteredTool {
  const preparedBindings = new Map<string, string>();
  async function prepare(input: unknown) {
    const args = z.record(z.string(), JsonSchema).parse(input);
    const parsed = Input.parse(args);
    const repository = GitHubRepositorySchema.parse(`${parsed.owner}/${parsed.repo}`);
    const account = Identity.parse(await servers.githubRead(userId, botId, serverId));
    const scope = await servers.githubAccess(userId, botId, serverId);
    // Validate all coordinates before an approval can be shown.
    if (name === 'fork_repository') {
      const fork = ForkInput.parse(args);
      if (fork.organization && fork.organization.toLowerCase() !== account.login.toLowerCase())
        throw new Error('This workflow forks into the connected GitHub account.');
      GitHubRepositorySchema.parse(`${account.login}/${fork.name ?? parsed.repo}`);
    } else {
      const pull = PullInput.parse(args);
      const parts = pull.head.split(':');
      if (parts.length > 2) throw new Error('Invalid pull-request head.');
      GitBranchSchema.parse(parts.at(-1));
      GitHubRepositorySchema.parse(
        `${parts.length === 2 ? parts[0] : parsed.owner}/${parsed.repo}`,
      );
    }
    return {
      grant: scope.gitGrantRevision,
      args,
      repository,
      account,
      revision: policyHash({ args, account: account.id, grant: scope.gitGrantRevision }),
    };
  }
  async function reconcile(
    prepared: Awaited<ReturnType<typeof prepare>>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (name === 'fork_repository') {
      const args = ForkInput.parse(prepared.args);
      const destination = `${prepared.account.login}/${args.name ?? args.repo}`;
      const data = await servers.githubArtifact(
        userId,
        botId,
        serverId,
        destination,
        undefined,
        signal,
      );
      if (data === null) return null;
      const fork = Fork.parse(data);
      const source = Fork.parse(
        await servers.githubRead(userId, botId, serverId, prepared.repository, undefined, signal),
      );
      if (
        !fork.fork ||
        String(fork.owner.id) !== prepared.account.id ||
        (fork.source?.id ?? fork.parent?.id) !== (source.source?.id ?? source.id)
      )
        throw new Error('The existing destination is not this account’s verified fork.');
      return `https://github.com/${fork.full_name}`;
    }
    const args = PullInput.parse(prepared.args);
    const label = args.head.includes(':') ? args.head : `${args.owner}:${args.head}`;
    const data = Pulls.parse(
      await servers.githubArtifact(
        userId,
        botId,
        serverId,
        prepared.repository,
        { head: label, base: args.base },
        signal,
      ),
    );
    const found = data.find(
      (pr) =>
        pr.head.label === label &&
        pr.base.ref === args.base &&
        pr.title === args.title &&
        (pr.body ?? '') === (args.body ?? '') &&
        pr.draft === args.draft &&
        String(pr.user.id) === prepared.account.id,
    );
    return found ? `https://github.com/${prepared.repository}/pull/${found.number}` : null;
  }
  const adapter: CommitAdapter = {
    proposal: async (args: Json) => {
      const prepared = await prepare(args);
      preparedBindings.set(policyHash(args), prepared.revision);
      return {
        account: prepared.account.login,
        destinations: [`https://github.com/${prepared.repository}`],
        contentRevision: prepared.revision,
      };
    },
    outcome: (output) => {
      const parsed = z
        .object({
          crewaidGitWrite: z.object({
            status: z.enum(['committed', 'uncertain']),
            reference: z.string().optional(),
          }),
        })
        .safeParse(output);
      return Promise.resolve(
        parsed.success &&
          parsed.data.crewaidGitWrite.status === 'committed' &&
          parsed.data.crewaidGitWrite.reference
          ? { status: 'committed', reference: parsed.data.crewaidGitWrite.reference }
          : { status: 'uncertain' },
      );
    },
  };
  return {
    ...tool,
    behavior: { ...tool.behavior, effect: 'unknown' },
    commitAdapter: adapter,
    build: (context) => ({
      ...tool.build(context),
      execute: async (input, options) => {
        const key = policyHash(input),
          approved = preparedBindings.get(key);
        preparedBindings.delete(key);
        const prepared = await prepare(input);
        if (!approved || prepared.revision !== approved)
          throw new Error('APPROVAL_STALE: GitHub publication changed.');
        const where = { userId, botId, serverId, toolName: name, argsHash: key };
        await prisma.gitRemoteWrite.createMany({
          data: { ...where, input: prepared.args, accountId: prepared.account.id },
          skipDuplicates: true,
        });
        const receipt = await prisma.gitRemoteWrite.findFirstOrThrow({ where });
        if (receipt.accountId !== prepared.account.id)
          throw new Error('APPROVAL_STALE: the connected account changed.');
        const existing = await reconcile(prepared, options.abortSignal);
        if (existing) {
          await prisma.gitRemoteWrite.updateMany({
            where,
            data: { status: 'CONFIRMED', reference: existing },
          });
          return {
            content: [{ type: 'text', text: JSON.stringify({ url: existing, existing: true }) }],
            crewaidGitWrite: { status: 'committed', reference: existing },
          };
        }
        if (receipt.status !== 'PREPARED')
          throw new Error(
            'A previous GitHub write is uncertain or changed. Check its remote artifact with read-only tools before creating it again.',
          );
        options.abortSignal?.throwIfAborted();
        const latest = await prepare(input);
        if (latest.revision !== approved) throw new Error('APPROVAL_STALE: GitHub access changed.');
        const claim = await prisma.gitRemoteWrite.updateMany({
          where: { ...where, status: 'PREPARED' },
          data: { status: 'SENDING' },
        });
        if (claim.count !== 1)
          throw new Error(
            'This GitHub write already started. Reconcile its outcome before continuing.',
          );
        try {
          const output = await servers.callTool(
            userId,
            serverId,
            name,
            z.record(z.string(), z.unknown()).parse(input),
            30_000,
            options.abortSignal,
            async () => {
              const current = await servers.githubAccess(userId, botId, serverId);
              if (current.gitGrantRevision !== prepared.grant)
                throw new Error(
                  'GRANT_REVOKED: GitHub access changed before the authenticated request.',
                );
            },
          );
          const reference = await reconcile(prepared, options.abortSignal);
          if (!reference) throw new Error('GitHub did not confirm the expected artifact.');
          await prisma.gitRemoteWrite.updateMany({
            where,
            data: { status: 'CONFIRMED', reference },
          });
          return { ...output, crewaidGitWrite: { status: 'committed', reference } };
        } catch {
          await prisma.gitRemoteWrite.updateMany({ where, data: { status: 'UNCERTAIN' } });
          return {
            content: [
              {
                type: 'text',
                text:
                  name === 'fork_repository'
                    ? 'The fork was not confirmed. Check repository or organization fork restrictions and inspect the account’s repositories with read-only tools. This request will not be replayed.'
                    : 'The pull request is uncertain. Check the expected pull request with read-only tools. This request will not be replayed.',
              },
            ],
            crewaidGitWrite: { status: 'uncertain' },
          };
        }
      },
    }),
  };
}
