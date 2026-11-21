import {
  REVISE_SKILL_INSTRUCTION_MAX_LENGTH,
  type Skill,
  type UpdateSkillBody,
} from '@crewaid/shared';
import type { ApiFailure } from '../api';
import { t } from '../i18n/i18n';

/**
 * The skill review surface, as pure functions.
 *
 * The same split as `recordingCardState`: the modal around this cannot be
 * rendered by the suite (`renderToStaticMarkup` has no DOM and React Aria
 * mounts dialogs into a portal), so every decision that a test can hold onto
 * lives here and the components only draw what these return.
 *
 * The editable surface is the script and the description — the two halves of
 * a skill a person can rewrite. `paramsSchema` is deliberately read-only: it
 * is the compiler's description of what the script takes, and freehand JSON
 * Schema editing is a feature of its own, not a line in this dialog. The
 * versioning rule is the contract's, not the UI's: a write answers the skill
 * with its `version` already bumped, and the surface adopts that response.
 * Nothing here predicts the next version number; it reads the one the server
 * just wrote.
 */

/** The editable half of a skill: what an edit can change on the PATCH contract. */
export type SkillDraft = {
  readonly description: string;
  readonly script: string;
};

/** A draft seeded from the stored skill. */
export function draftFromSkill(skill: Pick<Skill, 'description' | 'script'>): SkillDraft {
  return { description: skill.description, script: skill.script };
}

/**
 * The reason this draft cannot be saved, or null.
 *
 * `UpdateSkillBodySchema` requires a non-empty script, so the refusal happens
 * before the server's 400 — an empty script is a thing the editor made easy to
 * do and is trivially checkable, not a policy decision.
 */
export function draftIssue(draft: SkillDraft): string | null {
  if (draft.script.trim() === '') return t('skills.skillReviewState.theScriptCannotBeEmpty');
  return null;
}

/** True when the draft differs from what is stored. */
export function draftChanged(
  draft: SkillDraft,
  skill: Pick<Skill, 'description' | 'script'>,
): boolean {
  return draft.description !== skill.description || draft.script !== skill.script;
}

/**
 * Only the fields that actually changed, or null when nothing did.
 *
 * `PATCH /skills/:id` refuses an empty body, and sending unchanged values
 * would make every save a full overwrite — the same reasoning as
 * `botProfileForm.toUpdateBody`. Null rather than an empty object so a save
 * button can read "nothing to send" off one value instead of two checks.
 */
export function toUpdateBody(
  draft: SkillDraft,
  skill: Pick<Skill, 'description' | 'script'>,
): UpdateSkillBody | null {
  if (!draftChanged(draft, skill)) return null;
  return {
    ...(draft.description !== skill.description && { description: draft.description }),
    ...(draft.script !== skill.script && { script: draft.script }),
  };
}

/** What the review surface needs to say about a skill's standing. */
export interface SkillReviewPresentation {
  readonly statusLabel: string;
  readonly statusTone: 'warning' | 'success' | 'default';
  /** One sentence about what the status means for running the skill. */
  readonly statusNote: string;
  readonly versionLabel: string;
  readonly canEdit: boolean;
  readonly canApprove: boolean;
}

/** One parameter as a person reads it — the review's default view. */
export interface SkillParamView {
  readonly name: string;
  readonly type: string | null;
  readonly description: string | null;
  readonly required: boolean;
}

/**
 * `paramsSchema` flattened into rows, defensively.
 *
 * The column's wire type is the loose `JsonSchemaObjectSchema` — the compiler
 * assembles it, PATCH may carry one, and `save_skill` can write any object —
 * so the renderer reads `properties` the way it reads any JSON it did not
 * author: an entry that is not an object, or a `description` that is not a
 * string, costs that one row's detail rather than the whole panel. Row order
 * is the writer's, because the parameter list the model returned is a list.
 */
export function skillParams(schema: unknown): readonly SkillParamView[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return [];

  const required = new Set(
    Array.isArray((schema as { required?: unknown }).required)
      ? (schema as { required: unknown[] }).required.filter(
          (name): name is string => typeof name === 'string',
        )
      : [],
  );

  return Object.entries(properties as Record<string, unknown>).map(([name, spec]) => {
    const shape =
      typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>) : {};
    return {
      name,
      type: typeof shape.type === 'string' ? shape.type : null,
      description: typeof shape.description === 'string' ? shape.description : null,
      required: required.has(name),
    };
  });
}

/**
 * The revise input's refusal, or null.
 *
 * Kept in sync with the shared request schema so the UI refuses invalid text
 * before a model request is started.
 */
export function instructionIssue(instruction: string): string | null {
  const trimmed = instruction.trim();
  if (trimmed === '') return t('skills.skillReviewState.sayWhatShouldChange');
  if (trimmed.length > REVISE_SKILL_INSTRUCTION_MAX_LENGTH) {
    return t('skills.skillReviewState.keepTheChangeUnder', {
      count: REVISE_SKILL_INSTRUCTION_MAX_LENGTH,
    });
  }
  return null;
}

/**
 * The standing, from the skill the server last answered with.
 *
 * `APPROVED` is the only status M3 lets run (the acceptance criterion), so
 * the note says which side of that line the skill is on — the operator should
 * not have to know the enum to know whether stopping here is enough.
 */
export function skillReviewPresentation(skill: Skill): SkillReviewPresentation {
  const versionLabel = t('skills.skillReviewState.version', { version: skill.version });
  switch (skill.status) {
    case 'DRAFT':
      return {
        statusLabel: t('skills.skillReviewState.draft'),
        statusTone: 'warning',
        statusNote: t('skills.skillReviewState.draftCannotRun'),
        versionLabel,
        canEdit: true,
        canApprove: true,
      };
    case 'APPROVED':
      return {
        statusLabel: t('skills.skillReviewState.approved'),
        statusTone: 'success',
        statusNote: t('skills.skillReviewState.approvedCanRun'),
        versionLabel,
        canEdit: true,
        canApprove: false,
      };
    case 'ARCHIVED':
      // The PATCH table in the BE-09 contract allows an edit on any status —
      // saving an archived skill creates a new DRAFT version — so this surface
      // offers the edit rather than pretending the row is frozen. It is the
      // only gesture an archived row has.
      return {
        statusLabel: t('skills.skillReviewState.archived'),
        statusTone: 'default',
        statusNote: t('skills.skillReviewState.archivedCannotRun'),
        versionLabel,
        canEdit: true,
        canApprove: false,
      };
  }
}

/** The line shown after a save lands, naming the version the server wrote. */
export function savedNotice(skill: Skill): string {
  return t('skills.skillReviewState.savedAs', { version: skill.version });
}

/** The line shown after a plain-language change compiles into a new version. */
export function revisedNotice(skill: Skill): string {
  return t('skills.skillReviewState.updatedAs', { version: skill.version });
}

/** The line shown after an approval lands. */
export function approvedNotice(): string {
  return t('skills.skillReviewState.skillApproved');
}

/**
 * What the operator is told when a skill read or write fails.
 *
 * `ApiClient` has already stripped the response body; this maps the codes onto
 * the one thing the operator can act on.
 *
 * The two that are not generic are the two this surface actually produces.
 * `CONFLICT` names versioning, because a save writes a NEW version row and the
 * dialog may be holding one that is no longer the newest — reopening is the
 * recourse. `NOT_FOUND` stays blunt: D-010 answers 404 for a foreign row as
 * well as an absent one, so the honest sentence is that this id is gone, not a
 * guess about which of the two happened.
 */
export function skillFailureMessage(failure: ApiFailure): string {
  switch (failure.code) {
    case 'CONFIGURATION':
      return t('skills.skillReviewState.thisAppIsNotConnected');
    case 'NETWORK':
      return t('skills.skillReviewState.theServerCouldNotBe');
    case 'UNAUTHORIZED':
      return t('skills.skillReviewState.yourSessionHasEndedSign');
    case 'NOT_FOUND':
      return t('skills.skillReviewState.thisSkillNoLongerExists');
    case 'CONFLICT':
      return t('skills.skillReviewState.theSkillChangedOnThe');
    case 'INVALID_REQUEST':
      return t('skills.skillReviewState.someOfTheseValuesWere');
    case 'CONTRACT':
      return t('skills.skillReviewState.theServerSentAnAnswer');
    default:
      return failure.message;
  }
}

/**
 * What the operator is told when a plain-language change could not be compiled.
 *
 * The server answers a refused revision with 400 and a sentence written for
 * this surface — but the transport deliberately keeps response bodies out of
 * the UI (`apiError`'s D-006 rule), so this copy is the operator's whole
 * answer, and it has to carry the two ways forward: say it differently, or
 * open the source. `INVALID_REQUEST` is that refusal; `UNKNOWN` is the 5xx
 * and connection-shape of the same situation. Everything else keeps the
 * existing mapping, which already says the right thing about a dead socket or
 * a skill someone else moved.
 */
export function reviseFailureMessage(failure: ApiFailure): string {
  switch (failure.code) {
    case 'INVALID_REQUEST':
    case 'UNKNOWN':
      return t('skills.skillReviewState.theCompilerCouldNotApply');
    default:
      return skillFailureMessage(failure);
  }
}

/**
 * What the review surface is holding: the read in flight, its failure, or the
 * skill as the server last answered it.
 *
 * One shape rather than three booleans, so "loaded and failed" cannot be
 * represented — the states are exclusive by construction.
 */
export type SkillReviewLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly failure: ApiFailure }
  | { readonly status: 'ready'; readonly skill: Skill };
