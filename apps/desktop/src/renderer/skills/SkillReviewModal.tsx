import { Modal, useOverlayState } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Skill } from '@crewaid/shared';
import { approveSkill, failureOf, getSkill, reviseSkill, updateSkill, useApiClient } from '../api';
import { SkillReviewBody } from './SkillReviewBody';
import {
  approvedNotice,
  draftFromSkill,
  instructionIssue,
  revisedNotice,
  reviseFailureMessage,
  savedNotice,
  skillFailureMessage,
  toUpdateBody,
  type SkillDraft,
  type SkillReviewLoad,
} from './skillReviewState';
import { useT } from '../i18n/i18n';

/** Owns the skill review reads and writes; the body only renders their state. */
export function SkillReviewModal({
  skillId,
  isOpen,
  onOpenChange,
  onSkillSaved,
}: {
  /** The skill to review; `null` while nothing is open. */
  skillId: string | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired every time the surface adopts the row a write answered with. A save
   * or a revise creates a new version row — same skill name, new id — and the
   * caller keeps whatever points at the draft current (the recording card)
   * following along.
   */
  onSkillSaved?: ((skill: Skill) => void) | undefined;
}) {
  const t = useT();
  const client = useApiClient();

  const [load, setLoad] = useState<SkillReviewLoad>({ status: 'loading' });
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<null | 'saving' | 'approving' | 'revising'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // A write can create a new version even if its HTTP caller stops waiting.
  // Keep the modal mounted until the response is adopted by the card.
  const requestOpenChange = useCallback(
    (open: boolean) => {
      if (!open && busy !== null) return;
      onOpenChange(open);
    },
    [busy, onOpenChange],
  );
  const overlay = useOverlayState({ isOpen, onOpenChange: requestOpenChange });

  // Every read AND write the surface starts is stamped; only the newest may write.
  const generation = useRef(0);

  const startLoad = useCallback(
    (activeSkillId: string) => {
      const stamp = ++generation.current;
      setLoad({ status: 'loading' });
      setMode('view');
      setDraft(null);
      setInstruction('');
      setBusy(null);
      setNotice(null);
      setFailure(null);
      getSkill(client, activeSkillId)
        .then((skill) => {
          if (generation.current !== stamp) return;
          setLoad({ status: 'ready', skill });
          setDraft(draftFromSkill(skill));
        })
        .catch((error: unknown) => {
          if (generation.current !== stamp) return;
          setLoad({ status: 'error', failure: failureOf(error) });
        });
    },
    [client],
  );

  useEffect(() => {
    // A close — or a switched target — invalidates whatever is in flight; the
    // fresh open below always starts from its own loading state.
    generation.current += 1;
    if (!isOpen || skillId === null) return;
    startLoad(skillId);
  }, [isOpen, skillId, startLoad]);

  async function save(): Promise<void> {
    if (load.status !== 'ready' || draft === null || busy !== null) return;
    const body = toUpdateBody(draft, load.skill);
    if (body === null) return;
    // Stamped like a read, because a write outlives the dialog the same way:
    // this component is mounted for the app's lifetime and only `isOpen`
    // changes, so a save still in flight when the operator closes and opens a
    // DIFFERENT draft would otherwise load skill A into skill B's dialog and
    // hand A's new version to `onSkillSaved` — pointing B's card at it.
    const stamp = generation.current;
    setBusy('saving');
    setFailure(null);
    try {
      const skill = await updateSkill(client, load.skill.id, body);
      if (generation.current !== stamp) return;
      setLoad({ status: 'ready', skill });
      setDraft(draftFromSkill(skill));
      setMode('view');
      setNotice(savedNotice(skill));
      onSkillSaved?.(skill);
    } catch (error: unknown) {
      if (generation.current !== stamp) return;
      setFailure(skillFailureMessage(failureOf(error)));
    } finally {
      if (generation.current === stamp) setBusy(null);
    }
  }

  /** Wait for the compiler and adopt the version returned by the server. */
  async function revise(): Promise<void> {
    if (load.status !== 'ready' || busy !== null) return;
    const text = instruction.trim();
    if (instructionIssue(text) !== null) return;
    const stamp = generation.current;
    setBusy('revising');
    setFailure(null);
    try {
      const skill = await reviseSkill(client, load.skill.id, text);
      if (generation.current !== stamp) return;
      setLoad({ status: 'ready', skill });
      setDraft(draftFromSkill(skill));
      setMode('view');
      setInstruction('');
      setNotice(revisedNotice(skill));
      onSkillSaved?.(skill);
    } catch (error: unknown) {
      if (generation.current !== stamp) return;
      setFailure(reviseFailureMessage(failureOf(error)));
    } finally {
      if (generation.current === stamp) setBusy(null);
    }
  }

  async function approve(): Promise<void> {
    if (load.status !== 'ready' || busy !== null) return;
    const stamp = generation.current;
    setBusy('approving');
    setFailure(null);
    try {
      const skill = await approveSkill(client, load.skill.id);
      if (generation.current !== stamp) return;
      setLoad({ status: 'ready', skill });
      setDraft(draftFromSkill(skill));
      setNotice(approvedNotice());
      onSkillSaved?.(skill);
    } catch (error: unknown) {
      if (generation.current !== stamp) return;
      setFailure(skillFailureMessage(failureOf(error)));
    } finally {
      if (generation.current === stamp) setBusy(null);
    }
  }

  function beginEdit(): void {
    if (load.status !== 'ready' || busy !== null) return;
    setMode('edit');
    setDraft(draftFromSkill(load.skill));
    setInstruction('');
    setNotice(null);
    setFailure(null);
  }

  function cancelEdit(): void {
    if (load.status !== 'ready' || busy !== null) return;
    setMode('view');
    setDraft(draftFromSkill(load.skill));
    setInstruction('');
    setFailure(null);
  }

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center" scroll="inside">
          <Modal.Dialog
            aria-label={t('skills.skillReviewBody.reviewSkill')}
            className="flex max-h-[85vh] w-[min(880px,92vw)] max-w-none flex-col overflow-hidden rounded-card bg-surface p-5"
          >
            <SkillReviewBody
              load={load}
              mode={mode}
              draft={draft}
              instruction={instruction}
              busy={busy}
              notice={notice}
              failure={failure}
              onEdit={beginEdit}
              onCancelEdit={cancelEdit}
              onDraftChange={setDraft}
              onInstructionChange={setInstruction}
              onSave={() => void save()}
              onRevise={() => void revise()}
              onApprove={() => void approve()}
              onRetry={() => {
                if (skillId !== null) startLoad(skillId);
              }}
              onClose={() => requestOpenChange(false)}
            />
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
