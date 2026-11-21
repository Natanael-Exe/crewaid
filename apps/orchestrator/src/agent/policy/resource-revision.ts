import { policyHash } from './policy.js';

export function resolvedSkillRevision(skill: {
  id: string;
  version: number;
  script: string;
  paramsSchema: unknown;
  status: string;
}): string {
  return policyHash({
    id: skill.id,
    version: skill.version,
    script: skill.script,
    paramsSchema: skill.paramsSchema,
    status: skill.status,
  });
}
export function pluginRevision(
  serverId: string,
  tool: { name: string; inputSchema: unknown; readOnly: boolean; source?: string },
): string {
  return policyHash({
    serverId,
    name: tool.name,
    schema: tool.inputSchema,
    readOnly: tool.readOnly,
    source: tool.source ?? 'REMOTE',
  });
}
