import { Alert, Button, Chip, Dropdown, Input, Switch, Tooltip } from '@heroui/react';
import {
  IconChevronDown,
  IconDotsVertical,
  IconKey,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import type { ProviderConnectionWithModels, ProviderModel } from '@crewaid/shared';
import { IconButtonTooltip } from '../components/ui';
import {
  apiKeyIssue,
  connectionStatus,
  credentialSummary,
  keyIsWriteOnly,
  modelDraftFrom,
  providerLabel,
  type ConnectionTone,
  type ModelDraft,
} from './connectionsState';
import { capabilityLabels, contextWindowLabel } from './modelSettings';
import { ModelForm } from './ModelForm';
import { t, useT } from '../i18n/i18n';

/**
 * One provider connection, and everything that can be done to it.
 *
 * The key row is the point of this component
 *
 * There is no masked input holding dots. `hasCredential` is a boolean and
 * `credentialSetAt` is a date, and between them that is everything the server
 * will say. A field pre-filled with `••••••••` would be this app
 * inventing a value to display, and it teaches exactly the wrong thing: that
 * the key is sitting there and could come back if you clicked the right eye
 * icon. An operator who believes that treats rotation as a chance to lose it.
 *
 * So the control is a button that OPENS an empty field, and the field is only
 * ever an input — never an output.
 *
 * Why it is a card and not a stack of labelled rows
 *
 * It was six full-width rows, each with a title, a paragraph and a button:
 * Status, Name, API key, Enabled, the models, Add model. Every one of them was
 * true and together they buried the two things an operator came for — is this
 * on, and does it have a key — under prose they had already read.
 *
 * So the state an operator scans lives in the header as chips and a switch,
 * the settings an operator changes rarely (rename, remove) live behind the
 * overflow menu, and the body is the list of models, which is the part that
 * differs between connections and the only part worth vertical space.
 *
 * And the body closes
 *
 * Worth vertical space is not the same as free. Four connections with a few
 * models each is taller than the modal, so comparing them means scrolling past
 * the one you are not looking at — and the models you are scanning for are
 * always below the cards you already read. The chevron in the header closes a
 * card down to the header, which is the part that answers "which provider, is
 * it on, has it a key". A failure stays visible while collapsed: the overflow
 * menu still works, and putting its 409 inside a hidden div reports nothing.
 *
 * Presentational. Every round trip belongs to `ConnectionsPane`, which owns
 * the list and refetches it, because a mutation here changes `state` and
 * `models` on rows this component cannot see.
 */

export type ConnectionCardProps = {
  readonly connection: ProviderConnectionWithModels;
  readonly busy: boolean;
  /** Initial disclosure state; the settings pane leaves cards collapsed. */
  readonly defaultExpanded?: boolean;
  /** Set for whichever action last failed on THIS connection. */
  readonly problem: string | null;
  readonly onRename: (name: string) => void;
  readonly onSetEndpoint: (endpoint: string) => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onSetKey: (apiKey: string) => void;
  readonly onClearKey: () => void;
  readonly onRemove: () => void;
  readonly onAddModel: (draft: ModelDraft) => void;
  readonly onUpdateModel: (model: ProviderModel, draft: ModelDraft) => void;
  readonly onRemoveModel: (model: ProviderModel) => void;
};

/**
 * The overflow menu, as data.
 *
 * Rename, the key actions and Remove moved off the card and behind a menu:
 * they are what an operator does rarely, and as full-width rows they crowded
 * out the two facts that are read every time — is this on, and has it a key.
 *
 * Exported because React Aria builds a Dropdown's items when it OPENS, so none
 * of this is in the rendered markup and no render test can see it. An entry
 * that is enabled here and missing from `connectionMenuHandler` is a live-
 * looking row whose click does nothing, which is precisely the failure a
 * hidden menu makes easy.
 */
export const CONNECTION_MENU_ITEMS = [
  {
    id: 'rename',
    get label() {
      return t('settings.connection.menu.rename');
    },
  },
  {
    id: 'key',
    get label() {
      return t('settings.connection.menu.key');
    },
  },
  /** The revocation path. Offered only when there is something to revoke. */
  {
    id: 'clear-key',
    get label() {
      return t('settings.connection.menu.clearKey');
    },
    needsCredential: true,
  },
  {
    id: 'remove',
    get label() {
      return t('settings.connection.menu.remove');
    },
  },
] as const;

export type ConnectionMenuKey = (typeof CONNECTION_MENU_ITEMS)[number]['id'];

export type ConnectionMenuHandlers = {
  readonly rename: () => void;
  readonly key: () => void;
  readonly clearKey: () => void;
  readonly remove: () => void;
};

/** Which entries are unavailable for this connection, by id. */
export function connectionMenuDisabledKeys(hasCredential: boolean): ConnectionMenuKey[] {
  // Removing a key that does not exist is an action that can only fail.
  return hasCredential ? [] : ['clear-key'];
}

export function connectionMenuHandler(
  handlers: ConnectionMenuHandlers,
): (key: string | number) => void {
  return (key) => {
    switch (key) {
      case 'rename':
        handlers.rename();
        return;
      case 'key':
        handlers.key();
        return;
      case 'clear-key':
        handlers.clearKey();
        return;
      case 'remove':
        handlers.remove();
        return;
      default:
        return;
    }
  };
}

/** The shape of an endpoint, shown in the empty field; not a word, so not in the catalog. */
const ENDPOINT_EXAMPLE = 'https://api.example.com/v1';

const TONE_CHIP: Record<ConnectionTone, 'success' | 'warning' | 'default'> = {
  ok: 'success',
  warning: 'warning',
  muted: 'default',
};

export function ConnectionCard({
  connection,
  busy,
  defaultExpanded = false,
  problem,
  onRename,
  onSetEndpoint,
  onToggleEnabled,
  onSetKey,
  onClearKey,
  onRemove,
  onAddModel,
  onUpdateModel,
  onRemoveModel,
}: ConnectionCardProps) {
  const t = useT();
  const status = connectionStatus(connection);
  const [name, setName] = useState(connection.name);
  const [endpoint, setEndpoint] = useState(connection.endpoint ?? '');
  const [key, setKey] = useState('');
  const [keyOpen, setKeyOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Cards start collapsed because several model lists can be taller than the
  // modal. The initial value stays injectable so the presentational body can
  // be rendered and verified without turning these tests into browser tests.
  const [expanded, setExpanded] = useState(defaultExpanded);
  // One editor at a time: `null` closed, `'new'` adding, a model id editing
  // that row. Two open forms would let a save land on the row the operator
  // is no longer looking at.
  const [editing, setEditing] = useState<string | null>(null);

  const keyProblem = keyOpen ? apiKeyIssue(key) : null;
  const id = connection.id;

  // A connection with no key cannot be switched on, and the switch says so by
  // being unavailable rather than by accepting the click and silently
  // refusing — the state is NEEDS_CREDENTIAL, not "off".
  const keyless = connection.state === 'NEEDS_CREDENTIAL';

  return (
    <section className="crewaid-connection-card mb-4 overflow-hidden rounded-card border border-separator bg-surface">
      <header className="flex items-center gap-2.5 px-4 py-3 bg-muted/5">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-2">
              <Input
                id={`conn-name-${id}`}
                variant="secondary"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={name}
                aria-label={t('settings.connection.nameLabel')}
                onChange={(event) => setName(event.target.value)}
                className="w-full"
              />
              <Button
                variant="primary"
                size="sm"
                isDisabled={busy || name.trim() === '' || name.trim() === connection.name}
                onPress={() => {
                  onRename(name.trim());
                  setRenaming(false);
                }}
                className="h-9 shrink-0 rounded-[10px] px-3.5 text-caption font-medium"
              >
                {t('settings.general.save')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onPress={() => {
                  setName(connection.name);
                  setRenaming(false);
                }}
                className="h-9 shrink-0 rounded-[10px] px-3 text-caption font-medium text-muted"
              >
                {t('settings.cancel')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {/* The whole header is not the disclosure: it holds a switch, a
                menu and, while renaming, a text field, and a click target that
                contains three other controls swallows their presses. */}
              <IconButtonTooltip
                label={t('settings.connection.details', { name: connection.name })}
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                isDisabled={busy}
                onPress={() => setExpanded((open) => !open)}
                className="me-1 size-8 shrink-0 rounded-[10px] text-muted"
              >
                <IconChevronDown
                  className={
                    expanded
                      ? 'size-4 transition-transform'
                      : 'size-4 -rotate-90 transition-transform'
                  }
                  stroke={1.8}
                  aria-hidden
                />
              </IconButtonTooltip>

              <span className="truncate text-footnote font-medium text-foreground">
                {connection.name}
              </span>
              <Chip size="sm" variant="soft" color="default">
                <Chip.Label>{providerLabel(connection.kind)}</Chip.Label>
              </Chip>
              {/* The status chip carries the whole story the Status ROW used
                  to spell out in a sentence; `status.line` stays as the
                  accessible title so nothing is lost to someone who cannot
                  infer it from a colour. */}
              <Chip size="sm" variant="soft" color={TONE_CHIP[status.tone]} title={status.line}>
                <Chip.Label>{status.badge}</Chip.Label>
              </Chip>
            </div>
          )}
        </div>

        {renaming ? null : (
          <>
            {/* HeroUI's Switch is React Aria's SwitchField — a field, not a
                control. The checkbox carrying `role="switch"` and `onChange` is
                rendered by `Switch.Content` alone, so composed without it this
                was a picture of a switch: it showed the connection's state and
                no press ever changed anything. */}
            <Switch
              size="sm"
              isSelected={connection.state === 'ACTIVE'}
              isDisabled={busy || keyless}
              onChange={(enabled) => onToggleEnabled(enabled)}
              aria-label={t('settings.connection.enabled', { name: connection.name })}
              className="shrink-0"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>

            <Dropdown>
              <Tooltip delay={400}>
                <Dropdown.Trigger
                  aria-label={t('settings.connection.options', { name: connection.name })}
                  className="button button--ghost button--sm button--icon-only inline-flex size-8 shrink-0 items-center justify-center rounded-full p-0 text-muted"
                >
                  <IconDotsVertical className="size-4" stroke={1.8} aria-hidden />
                </Dropdown.Trigger>
                <Tooltip.Content>
                  {t('settings.connection.options', { name: connection.name })}
                </Tooltip.Content>
              </Tooltip>
              <Dropdown.Popover placement="bottom end" className="min-w-[184px] rounded-xl">
                <Dropdown.Menu
                  aria-label={t('settings.connection.options', { name: connection.name })}
                  onAction={connectionMenuHandler({
                    rename: () => setRenaming(true),
                    key: () => setKeyOpen(true),
                    clearKey: onClearKey,
                    remove: onRemove,
                  })}
                  disabledKeys={connectionMenuDisabledKeys(connection.hasCredential)}
                >
                  <Dropdown.Item
                    id="rename"
                    textValue={t('settings.connection.menu.rename')}
                    className="rounded-lg"
                  >
                    <IconPencil className="size-4 shrink-0" stroke={1.8} />
                    <span>{t('settings.connection.menu.rename')}</span>
                  </Dropdown.Item>
                  <Dropdown.Item
                    id="key"
                    textValue={t('settings.connection.replaceKey')}
                    className="rounded-lg"
                  >
                    <IconKey className="size-4 shrink-0" stroke={1.8} />
                    <span>
                      {connection.hasCredential
                        ? t('settings.connection.replaceKey')
                        : t('settings.connection.setKey')}
                    </span>
                  </Dropdown.Item>
                  <Dropdown.Item
                    id="clear-key"
                    textValue={t('settings.connection.menu.clearKey')}
                    className="rounded-lg"
                  >
                    <IconTrash className="size-4 shrink-0" stroke={1.8} />
                    <span>{t('settings.connection.menu.clearKey')}</span>
                  </Dropdown.Item>
                  <Dropdown.Item
                    id="remove"
                    variant="danger"
                    textValue={t('settings.connection.menu.remove')}
                    className="rounded-lg text-danger data-[hovered]:text-danger"
                  >
                    <IconTrash className="size-4 shrink-0 text-danger" stroke={1.8} />
                    <span className="text-danger">{t('settings.connection.menu.remove')}</span>
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </>
        )}
      </header>

      {/* Everything below the header collapses. The header is the whole of what
          an operator scans — name, provider, state, on/off — so a collapsed
          card still answers the two questions this pane exists for.

          A failure is NOT part of the collapsible body. Actions behind the
          overflow menu still run while collapsed, and a 409 that names a bot
          would otherwise be thrown away inside a hidden div. */}
      {expanded ? (
        <>
          {connection.kind === 'custom' ? (
            <div className="border-t border-separator px-4 py-3">
              <label
                htmlFor={`conn-endpoint-${id}`}
                className="mb-1.5 block text-caption font-medium text-foreground"
              >
                {t('settings.connections.baseUrl.label')}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={`conn-endpoint-${id}`}
                  variant="secondary"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={ENDPOINT_EXAMPLE}
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  className="w-full"
                />
                <Button
                  variant="tertiary"
                  size="sm"
                  isDisabled={busy || endpoint.trim() === (connection.endpoint ?? '')}
                  onPress={() => onSetEndpoint(endpoint.trim())}
                  className="h-9 shrink-0 rounded-[10px] px-3.5 text-caption font-medium"
                >
                  {t('settings.general.save')}
                </Button>
              </div>
              {/* Said here because the refusal happens at the orchestrator and
              arrives as a 400 that would otherwise read as a typo: the address
              is re-checked every time a turn runs, and a host that resolves
              onto the deployment's own network is refused then too (D-085). */}
              <p className="mt-1.5 text-caption leading-[17px] text-muted">
                {t('settings.connection.endpointHint')}
              </p>
            </div>
          ) : null}

          {keyOpen ? (
            <div className="border-t border-separator px-4 py-3">
              <label
                htmlFor={`conn-key-${id}`}
                className="mb-1.5 block text-caption font-medium text-foreground"
              >
                {t('settings.connections.apiKey.label')}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={`conn-key-${id}`}
                  variant="secondary"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('settings.connections.apiKey.placeholder')}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  className="w-full"
                  aria-label={t('settings.connections.apiKey.label')}
                />
                <Button
                  variant="primary"
                  size="sm"
                  isDisabled={busy || keyProblem !== null}
                  onPress={() => {
                    const value = key.trim();
                    // Cleared before the round trip, not after: the field is a
                    // write-only input and keeping the secret in React state while
                    // a request is in flight puts it in a component tree a devtools
                    // session can read.
                    setKey('');
                    setKeyOpen(false);
                    onSetKey(value);
                  }}
                  className="h-9 shrink-0 rounded-[10px] px-3.5 text-caption font-medium"
                >
                  {t('settings.connection.saveKey')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    setKey('');
                    setKeyOpen(false);
                  }}
                  className="h-9 shrink-0 rounded-[10px] px-3 text-caption font-medium text-muted"
                >
                  {t('settings.cancel')}
                </Button>
              </div>
              <p className="mt-1.5 text-caption leading-[17px] text-muted">{keyIsWriteOnly()}</p>
              {keyProblem === null ? null : <CardAlert>{keyProblem}</CardAlert>}
            </div>
          ) : (
            <div className="flex items-center gap-2 border-t border-separator px-4 py-2.5">
              <span className="text-caption text-muted">{credentialSummary(connection)}</span>
              {/* The guarantee stays on screen rather than only inside the form:
              it is what stops someone hunting for a reveal control, and the
              full sentence is the title so the short chip loses nothing. */}
              <Chip size="sm" variant="soft" color="default" title={keyIsWriteOnly()}>
                <Chip.Label>{t('settings.connection.writeOnly')}</Chip.Label>
              </Chip>
              <Button
                variant="tertiary"
                size="sm"
                isDisabled={busy}
                onPress={() => setKeyOpen(true)}
                className="ms-auto h-8 shrink-0 rounded-[10px] px-3 text-caption font-medium"
              >
                {connection.hasCredential
                  ? t('settings.connection.replaceKey')
                  : t('settings.connection.setKey')}
              </Button>
            </div>
          )}

          {connection.kind === 'elevenlabs' ? (
            // A speech key has no models; it is what bots listen and
            // speak with, so the card says that instead of offering a list.
            <p className="border-t border-separator px-4 py-2.5 text-caption text-muted">
              {t('settings.connection.speechKey')}
            </p>
          ) : (
            <div className="border-t border-separator">
              <div className="flex items-center gap-2 px-4 py-2.5">
                <span className="text-caption font-medium text-muted tabular-nums">
                  {connection.models.length > 0
                    ? t('settings.connection.modelsCount', { count: connection.models.length })
                    : t('settings.connection.models')}
                </span>
                <Button
                  variant={editing === 'new' ? 'ghost' : 'primary'}
                  size="sm"
                  isDisabled={busy}
                  onPress={() => setEditing((open) => (open === 'new' ? null : 'new'))}
                  className="ms-auto h-8 shrink-0 rounded-[10px] px-3 text-caption font-medium"
                >
                  <IconPlus className="me-1 size-4" stroke={1.8} aria-hidden />
                  {t('settings.connection.addModel')}
                </Button>
              </div>

              {connection.models.map((definition) =>
                editing === definition.id ? (
                  <div key={definition.id} className="border-t border-separator px-4 py-3">
                    <ModelForm
                      initial={modelDraftFrom(definition)}
                      busy={busy}
                      submitLabel={t('settings.connection.saveModel')}
                      onSubmit={(draft) => {
                        setEditing(null);
                        onUpdateModel(definition, draft);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                ) : (
                  <div
                    key={definition.id}
                    className="flex items-center gap-2 border-t border-separator px-4 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-footnote font-medium text-foreground">
                          {definition.label}
                        </span>
                        {capabilityLabels(definition.capabilities).map((capability) => (
                          <Chip key={capability} size="sm" variant="soft" color="accent">
                            <Chip.Label>{capability}</Chip.Label>
                          </Chip>
                        ))}
                      </div>
                      {/* The provider's own id, not the row id. A bot stores the row
                    id (D-082) and a cuid tells an operator nothing — what they
                    check against a provider dashboard is the name the provider
                    knows. */}
                      <code className="mt-0.5 block truncate text-micro text-muted">
                        {definition.upstreamModelId}
                      </code>
                    </div>
                    <span className="shrink-0 text-micro text-foreground-faint tabular-nums">
                      {contextWindowLabel(definition.contextWindow)}
                    </span>
                    {/* Editing in place rather than delete-and-re-add: re-adding
                  mints a new row id, and every bot pointing at the old one
                  stops resolving (D-082). */}
                    <IconButtonTooltip
                      label={t('settings.connection.editModel', { model: definition.label })}
                      variant="ghost"
                      size="sm"
                      isDisabled={busy}
                      onPress={() => setEditing(definition.id)}
                      className="size-8 shrink-0 rounded-[10px] text-muted"
                    >
                      <IconPencil className="size-4" stroke={1.8} aria-hidden />
                    </IconButtonTooltip>
                    <IconButtonTooltip
                      label={t('settings.connection.removeModel', { model: definition.label })}
                      variant="ghost"
                      size="sm"
                      isDisabled={busy}
                      onPress={() => onRemoveModel(definition)}
                      className="size-8 shrink-0 rounded-[10px] text-muted hover:text-danger"
                    >
                      <IconTrash className="size-4" stroke={1.8} aria-hidden />
                    </IconButtonTooltip>
                  </div>
                ),
              )}

              {connection.models.length === 0 && editing === null ? (
                <p className="border-t border-separator px-4 py-2.5 text-caption text-muted">
                  {t('settings.connection.noModels')}
                </p>
              ) : null}

              {editing === 'new' ? (
                <div className="border-t border-separator px-4 py-3">
                  <ModelForm
                    busy={busy}
                    submitLabel={t('settings.connection.addModel')}
                    onSubmit={(draft) => {
                      setEditing(null);
                      onAddModel(draft);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : null}

      {problem === null ? null : (
        <div className="border-t border-separator px-4 py-2.5">
          <CardAlert>{problem}</CardAlert>
        </div>
      )}
    </section>
  );
}

function CardAlert({ children }: { children: React.ReactNode }) {
  return (
    <Alert status="danger" role="alert" className="mt-1.5">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}
