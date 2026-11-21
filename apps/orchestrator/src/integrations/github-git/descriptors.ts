import { z } from 'zod';
import {
  JsonSchema,
  GitCloneInputSchema,
  GitFetchInputSchema,
  GitPushInputSchema,
} from '@crewaid/shared';
import type { McpServer } from '@prisma/client';
import type { McpToolDescriptor } from '../../mcp/mcp-tools.js';

export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
export const GIT_TOOL_NAMES = [
  'crewaid_git_clone',
  'crewaid_git_fetch',
  'crewaid_git_push',
] as const;
export function isCanonicalGitHub(
  server: Pick<McpServer, 'backend' | 'slug' | 'url' | 'authType' | 'isPrivate'>,
): boolean {
  return (
    server.backend === 'DIRECT' &&
    server.slug === 'github' &&
    server.url === GITHUB_MCP_URL &&
    server.authType === 'OAUTH2' &&
    !server.isPrivate
  );
}
const schemaOf = (schema: z.ZodType) =>
  z.record(z.string(), JsonSchema).parse(z.toJSONSchema(schema, { target: 'draft-7' }));
export function gitToolDescriptors(): McpToolDescriptor[] {
  return [
    {
      name: GIT_TOOL_NAMES[0],
      description:
        'Clone a GitHub repository, including private repositories, onto this bot’s computer. Returns an owned checkout ID. Use computer tools to edit, test and commit. No browser sign-in is needed.',
      inputSchema: schemaOf(GitCloneInputSchema),
      readOnlyHint: false,
    },
    {
      name: GIT_TOOL_NAMES[1],
      description:
        'Fetch remote-tracking branches for an owned checkout, preserving working files. Use this instead of shell Git for authenticated fetches.',
      inputSchema: schemaOf(GitFetchInputSchema),
      readOnlyHint: false,
    },
    {
      name: GIT_TOOL_NAMES[2],
      description:
        'Publish committed HEAD from an owned checkout to a feature branch. If source push access is unavailable, use GitHub’s fork tool first, then select the verified fork as targetRepository. Open a draft PR with GitHub tools after publishing. Never merge automatically.',
      inputSchema: schemaOf(GitPushInputSchema),
      readOnlyHint: false,
    },
  ];
}
