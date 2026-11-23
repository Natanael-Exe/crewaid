import { Button, Input, Modal, useOverlayState } from '@heroui/react';
import { IconArchive, IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type { ProjectWithCounts } from '@crewaid/shared';
import { failureOf } from '../api';
import type { ApiClient } from '../api/apiClient';
import { createProject, deleteProject, updateProject } from '../api/work';
import { IconButtonTooltip } from '../components/ui';
import { workFailureText } from './workErrors';
import { PROJECT_COLORS, nextProjectColor } from './workState';
import { useT } from '../i18n/i18n';

/** A name and a colour: all a project is. */
export function NewProjectDialog({
  isOpen,
  onOpenChange,
  client,
  projects,
  onCreated,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  client: ApiClient;
  projects: readonly ProjectWithCounts[];
  onCreated: (project: ProjectWithCounts) => void;
}) {
  const t = useT();
  const overlay = useOverlayState({ isOpen, onOpenChange });
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setColor(nextProjectColor(projects));
    setFailure(null);
  }, [isOpen, projects]);

  async function save(): Promise<void> {
    if (name.trim() === '' || saving) return;
    setSaving(true);
    try {
      const project = await createProject(client, { name: name.trim(), color });
      onCreated(project);
      onOpenChange(false);
    } catch (error) {
      setFailure(workFailureText(failureOf(error)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center" scroll="inside">
          <Modal.Dialog aria-label={t('work.projectDialogs.newProject')}>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading className="text-body font-semibold">
                {t('work.projectDialogs.newProject')}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <div>
                <label htmlFor="project-name" className="mb-1.5 block text-caption text-muted">
                  {t('work.projectDialogs.name')}
                </label>
                <Input
                  id="project-name"
                  variant="secondary"
                  autoFocus
                  value={name}
                  maxLength={80}
                  placeholder={t('work.projectDialogs.acmeSaas')}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void save();
                  }}
                  className="w-full"
                />
              </div>
              <ColorChoice value={color} onChange={setColor} />
              {failure === null ? null : (
                <p role="alert" className="text-caption text-danger">
                  {failure}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer className="gap-2">
              <Button variant="tertiary" size="sm" onPress={() => onOpenChange(false)}>
                {t('work.goalsView.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isDisabled={saving || name.trim() === ''}
                onPress={() => void save()}
              >
                {saving ? t('work.projectDialogs.creating') : t('work.projectDialogs.create')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function ColorChoice({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t('work.projectDialogs.colour')} className="flex gap-2">
      {PROJECT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          onClick={() => onChange(color)}
          className={`size-6 rounded-full outline-none ring-offset-2 ring-offset-surface focus-visible:ring-2 focus-visible:ring-focus ${
            value === color ? 'ring-2 ring-foreground/60' : ''
          }`}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

/**
 * Rename, archive, restore or delete projects.
 */
export function ManageProjectsDialog({
  isOpen,
  onOpenChange,
  client,
  projects,
  onChanged,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  client: ApiClient;
  projects: readonly ProjectWithCounts[];
  onChanged: () => void;
}) {
  const t = useT();
  const overlay = useOverlayState({ isOpen, onOpenChange });
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    if (isOpen) setFailures({});
  }, [isOpen]);

  async function act(projectId: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
      setFailures((current) => ({ ...current, [projectId]: '' }));
      onChanged();
    } catch (error) {
      setFailures((current) => ({ ...current, [projectId]: workFailureText(failureOf(error)) }));
    }
  }

  return (
    <Modal state={overlay}>
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog
            aria-label={t('work.projectDialogs.manageProjects')}
            className="sm:max-w-[480px]"
          >
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading className="text-body font-semibold">
                {t('work.projectDialogs.projects')}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              {projects.length === 0 ? (
                <p className="text-footnote text-muted">{t('work.projectDialogs.noProjectsYet')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {projects.map((project) => (
                    <li key={project.id} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: project.color }}
                        />
                        <Input
                          variant="secondary"
                          aria-label={t('work.project.nameOf', { name: project.name })}
                          defaultValue={project.name}
                          maxLength={80}
                          onBlur={(event) => {
                            const name = event.target.value.trim();
                            if (name !== '' && name !== project.name) {
                              void act(project.id, () =>
                                updateProject(client, project.id, { name }),
                              );
                            }
                          }}
                          className={`h-8 flex-1 ${project.status === 'ARCHIVED' ? 'text-muted' : ''}`}
                        />
                        <IconButtonTooltip
                          label={
                            project.status === 'ARCHIVED'
                              ? t('work.project.restore', { name: project.name })
                              : t('work.project.archive', { name: project.name })
                          }
                          onPress={() =>
                            void act(project.id, () =>
                              updateProject(client, project.id, {
                                status: project.status === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED',
                              }),
                            )
                          }
                          className="size-8 rounded-lg text-muted"
                        >
                          {project.status === 'ARCHIVED' ? (
                            <IconArrowBackUp className="size-4 rtl:-scale-x-100" stroke={1.8} />
                          ) : (
                            <IconArchive className="size-4" stroke={1.8} />
                          )}
                        </IconButtonTooltip>
                        <IconButtonTooltip
                          label={t('work.project.delete', { name: project.name })}
                          onPress={() =>
                            void act(project.id, () => deleteProject(client, project.id))
                          }
                          className="size-8 rounded-lg text-danger"
                        >
                          <IconTrash className="size-4" stroke={1.8} />
                        </IconButtonTooltip>
                      </div>
                      {failures[project.id] ? (
                        <p role="alert" className="ps-4.5 text-micro text-danger">
                          {failures[project.id]}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" size="sm" onPress={() => onOpenChange(false)}>
                {t('work.messageWorkDialogs.done')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
