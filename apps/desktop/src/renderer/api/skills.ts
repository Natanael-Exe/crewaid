import {
  API_ROUTES,
  SkillWithSourceSchema,
  type Skill,
  type UpdateSkillBody,
} from '@crewaid/shared';
import type { ApiClient } from './apiClient';

/**
 * REST skill review routes.
 *
 * Five calls, and each answers the skill as it stands after the call:
 *
 * - the read is what the review surface opens on;
 * - the write answers the edited skill, whose `version` the orchestrator
 * has already bumped — adopting the response keeps the surface honest
 * without a second read that could race the next edit;
 * - revise takes a plain-language change and answers the NEW version the
 * compiler wrote from it — the path an edit takes when the person does
 * not want to (or should not have to) read the script;
 * - the discard answers nothing: the draft is gone, and the id the caller
 * sent is the only fact there was to learn;
 * - approve answers the same shape with `status` moved to `APPROVED` (a
 * skill can only be run once approved, so this is the transition the
 * whole review flow exists to make).
 *
 * The three that answer a skill parse through the same shared schema the read
 * does: the response to a write is a wire shape like any other, and letting it
 * skip validation would make an edit the one route where the renderer renders
 * what it did not verify (D-008's rule, applied to REST).
 */

/** `GET /skills/:id` — the skill with its source, as stored. */
export function getSkill(client: ApiClient, skillId: string): Promise<Skill> {
  return client.request(API_ROUTES.skills.get, {
    params: { id: skillId },
    schema: SkillWithSourceSchema,
  });
}

/** `PATCH /skills/:id` — edit script, description, paramsSchema; bumps `version`. */
export function updateSkill(
  client: ApiClient,
  skillId: string,
  body: UpdateSkillBody,
): Promise<Skill> {
  return client.request(API_ROUTES.skills.update, {
    params: { id: skillId },
    body,
    schema: SkillWithSourceSchema,
  });
}

/**
 * `POST /skills/:id/revise` — a change in plain language, compiled.
 *
 * A model call bounded by the same deadline a compile gets, so the caller
 * should expect the dialog to wait; the answer is the next version row, back
 * to `DRAFT` like every other model-written version.
 */
export function reviseSkill(
  client: ApiClient,
  skillId: string,
  instruction: string,
): Promise<Skill> {
  return client.request(API_ROUTES.skills.revise, {
    params: { id: skillId },
    body: { instruction },
    schema: SkillWithSourceSchema,
  });
}

/** `DELETE /skills/:id` — throw a DRAFT away; 204, so there is nothing to parse. */
export function deleteSkill(client: ApiClient, skillId: string): Promise<void> {
  return client.request(API_ROUTES.skills.remove, { params: { id: skillId } });
}

/** `POST /skills/:id/approve` — `DRAFT` → `APPROVED`. */
export function approveSkill(client: ApiClient, skillId: string): Promise<Skill> {
  return client.request(API_ROUTES.skills.approve, {
    params: { id: skillId },
    schema: SkillWithSourceSchema,
  });
}
