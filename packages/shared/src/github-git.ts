import { z } from 'zod';

export const GitHubRepositorySchema = z
  .string()
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
  .refine((name) => !['.', '..'].includes(name.split('/')[1] ?? ''));
export const GitBranchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (name) =>
      !name.includes('..') &&
      !name.includes('//') &&
      !name.endsWith('.lock') &&
      !name.endsWith('/') &&
      !name.endsWith('.'),
    'Invalid Git branch',
  );
export const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const GitRelativeDirectorySchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').some((part) => part === '' || part === '.' || part === '..') &&
      [...path].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    'A relative workspace directory is required',
  );
export const GitCloneInputSchema = z
  .object({
    repository: GitHubRepositorySchema,
    branch: GitBranchSchema.optional(),
    directory: GitRelativeDirectorySchema.optional(),
  })
  .strict();
export const GitFetchInputSchema = z.object({ checkoutId: z.string().min(1) }).strict();
export const GitPushInputSchema = z
  .object({
    checkoutId: z.string().min(1),
    branch: GitBranchSchema,
    targetRepository: GitHubRepositorySchema.optional(),
  })
  .strict();
export const GitCheckoutResultSchema = z
  .object({
    checkoutId: z.string(),
    path: z.string(),
    repository: GitHubRepositorySchema,
    branch: z.string(),
    head: GitObjectIdSchema,
  })
  .strict();
export const GitPushResultSchema = z
  .object({
    status: z.enum(['committed', 'uncertain', 'refused']),
    repository: GitHubRepositorySchema,
    branch: GitBranchSchema,
    head: GitObjectIdSchema,
    reference: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
export const GitChangeReviewSchema = z
  .object({
    repository: GitHubRepositorySchema,
    branch: GitBranchSchema,
    commit: GitObjectIdSchema,
    files: z.array(z.string()).max(200),
    summary: z.string().max(16000),
  })
  .strict();
export type GitCloneInput = z.infer<typeof GitCloneInputSchema>;
export type GitPushInput = z.infer<typeof GitPushInputSchema>;
