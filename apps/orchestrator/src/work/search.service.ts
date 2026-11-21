import { Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  type DeliverableKind,
  type GoalStatus,
  type ProjectStatus,
  type TaskStatus,
} from '@prisma/client';
import type { SearchQuery, SearchResponse, SearchType } from '@crewaid/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { TRANSCRIPT_HEADLINE, searchTranscripts } from '../messages/transcript-search.js';

const ALL_TYPES: readonly SearchType[] = ['task', 'goal', 'project', 'deliverable', 'message'];

/**
 * D-077's excerpt: at most two fragments, matches wrapped in `<<` and `>>`.
 * The renderer splits on the markers and never reads the result as HTML.
 */
const HEADLINE = TRANSCRIPT_HEADLINE;

/**
 * Global search: one box over the user's tasks, goals, projects,
 * deliverables and every one of their bots' transcripts.
 *
 * The expressions are the indexes'
 *
 * Each query below spells its `to_tsvector` exactly as the hand-written index
 * in the M10 migration does (`Task_search_fts_idx`, `Goal_search_fts_idx`,
 * `Deliverable_search_fts_idx`). A different spelling returns the same rows by
 * sequential scan and nothing fails, so `m10-search.integration.test.ts`
 * checks the plans use the indexes. Transcripts have no index: their text is
 * sealed at rest, and `messages/transcript-search.ts` ranks it opened.
 *
 * D-077's own-transcript boundary is a bot's: a bot searches its own past.
 * The user who owns every bot searches all of them.
 */
@Injectable()
export class SearchService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async search(userId: string, query: SearchQuery): Promise<SearchResponse> {
    const types = new Set(query.types ?? ALL_TYPES);
    const q = query.q;
    const limit = query.limit;
    const [tasks, goals, projects, deliverables, messages] = await Promise.all([
      types.has('task') ? this.tasks(userId, q, limit, query.projectId) : [],
      types.has('goal') ? this.goals(userId, q, limit, query.projectId) : [],
      types.has('project') && query.projectId === undefined ? this.projects(userId, q, limit) : [],
      types.has('deliverable')
        ? this.deliverables(userId, q, limit, query.projectId, query.botId)
        : [],
      types.has('message') && query.projectId === undefined
        ? this.messages(userId, q, limit, query.botId)
        : [],
    ]);
    return { tasks, goals, projects, deliverables, messages };
  }

  private tasks(userId: string, q: string, limit: number, projectId: string | undefined) {
    const project =
      projectId === undefined ? Prisma.empty : Prisma.sql`AND t."projectId" = ${projectId}`;
    return this.prisma.$queryRaw<
      {
        id: string;
        title: string;
        status: TaskStatus;
        assigneeBotId: string | null;
        projectId: string | null;
        excerpt: string | null;
      }[]
    >`
      SELECT t.id, t.title, t.status, t."assigneeBotId", t."projectId",
             ts_headline('english', t.title || ' ' || coalesce(t.brief, ''),
                         websearch_to_tsquery('english', ${q}), ${HEADLINE}) AS excerpt
      FROM "Task" t
      WHERE t."userId" = ${userId} ${project}
        AND to_tsvector('english', "title" || ' ' || coalesce("brief", ''))
            @@ websearch_to_tsquery('english', ${q})
      ORDER BY ts_rank_cd(to_tsvector('english', "title" || ' ' || coalesce("brief", '')),
                          websearch_to_tsquery('english', ${q})) DESC,
               t."updatedAt" DESC
      LIMIT ${limit}
    `;
  }

  private goals(userId: string, q: string, limit: number, projectId: string | undefined) {
    const project =
      projectId === undefined ? Prisma.empty : Prisma.sql`AND g."projectId" = ${projectId}`;
    return this.prisma.$queryRaw<
      {
        id: string;
        title: string;
        status: GoalStatus;
        projectId: string | null;
        excerpt: string | null;
      }[]
    >`
      SELECT g.id, g.title, g.status, g."projectId",
             ts_headline('english', g.title || ' ' || coalesce(g.outcome, ''),
                         websearch_to_tsquery('english', ${q}), ${HEADLINE}) AS excerpt
      FROM "Goal" g
      WHERE g."userId" = ${userId} ${project}
        AND to_tsvector('english', "title" || ' ' || coalesce("outcome", ''))
            @@ websearch_to_tsquery('english', ${q})
      ORDER BY ts_rank_cd(to_tsvector('english', "title" || ' ' || coalesce("outcome", '')),
                          websearch_to_tsquery('english', ${q})) DESC,
               g."updatedAt" DESC
      LIMIT ${limit}
    `;
  }

  /** A user has a handful of projects; a name match is what finds one. */
  private projects(userId: string, q: string, limit: number) {
    return this.prisma.$queryRaw<
      { id: string; name: string; color: string; status: ProjectStatus }[]
    >`
      SELECT p.id, p.name, p.color, p.status
      FROM "Project" p
      WHERE p."userId" = ${userId} AND p.name ILIKE ${`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`}
      ORDER BY p."sortOrder" ASC, p."createdAt" ASC
      LIMIT ${limit}
    `;
  }

  private deliverables(
    userId: string,
    q: string,
    limit: number,
    projectId: string | undefined,
    botId: string | undefined,
  ) {
    const project =
      projectId === undefined ? Prisma.empty : Prisma.sql`AND d."projectId" = ${projectId}`;
    const bot = botId === undefined ? Prisma.empty : Prisma.sql`AND d."botId" = ${botId}`;
    return this.prisma.$queryRaw<
      {
        id: string;
        kind: DeliverableKind;
        title: string;
        botId: string | null;
        taskId: string | null;
        goalId: string | null;
        projectId: string | null;
        createdAt: Date;
        excerpt: string | null;
      }[]
    >`
      SELECT d.id, d.kind, d.title, d."botId", d."taskId", d."goalId", d."projectId", d."createdAt",
             ts_headline('english',
                         d.title || ' ' || coalesce(d.summary, '') || ' ' || coalesce(d."searchText", ''),
                         websearch_to_tsquery('english', ${q}), ${HEADLINE}) AS excerpt
      FROM "Deliverable" d
      WHERE d."userId" = ${userId} ${project} ${bot}
        AND to_tsvector('english',
              "title" || ' ' || coalesce("summary", '') || ' ' || coalesce("searchText", ''))
            @@ websearch_to_tsquery('english', ${q})
      ORDER BY ts_rank_cd(to_tsvector('english',
                 "title" || ' ' || coalesce("summary", '') || ' ' || coalesce("searchText", '')),
               websearch_to_tsquery('english', ${q})) DESC,
               d."createdAt" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * Every one of the user's transcripts — the same search D-077's memory_search
   * makes for one bot. Message text is sealed at rest (D-236), so this one is
   * ranked from opened text rather than from an index.
   */
  private async messages(userId: string, q: string, limit: number, botId: string | undefined) {
    const hits = await searchTranscripts(this.prisma, { userId, botId }, q, limit);
    return hits.map(({ id, botId: bot, author, createdAt, excerpt }) => ({
      id,
      botId: bot,
      author,
      createdAt,
      excerpt,
    }));
  }
}
