import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TemplateSchema, welcomeCopy, type McpServerSummary, type Template } from '@crewaid/shared';
import { BotFields } from '../src/renderer/bots/BotFields';
import {
  exampleTasks,
  StartingPoints,
  WelcomeOpening,
  WelcomeReplies,
  welcomeOffer,
} from '../src/renderer/experience/Welcome';
import type { TranscriptMessage } from '../src/renderer/state/viewTypes';
import { TemplateBrowse, visibleTemplates } from '../src/renderer/experience/TemplateBrowse';
import { TemplateResultCard } from '../src/renderer/experience/TemplateResultCard';
import { CrewSetup } from '../src/renderer/experience/TemplateSetup';
import {
  NO_CONNECTIONS,
  draftFromTemplate,
  prefillFrom,
  toolState,
  type Connections,
} from '../src/renderer/experience/templateView';

const WELCOME_COPY = welcomeCopy('en');

const hannah = {
  key: 'hannah',
  name: 'Hannah',
  role: 'Demand Gen & Social Writer',
  summary: 'Turn a focused brief into clear posts.',
  systemPrompt: 'You write sharp, concrete content.',
  avatarColor: '#d6336c',
  avatarShape: 'cloud',
  toolSlugs: ['notion'],
} as const;
const tariq = { ...hannah, key: 'tariq', name: 'Tariq', role: 'Signal & Trend Hunter' };
const base = {
  revision: '2',
  outcomes: ['Draft posts in your voice'],
  inputs: ['Your audience'],
  examples: [{ title: 'Three drafts', content: 'Illustrative content' }],
  tools: [{ slug: 'notion', label: 'Notion', required: false }],
  starterTask: 'Ask the Content crew to draft a post.',
  routineSuggestion: 'Nothing repeats until you choose when.',
};
const crew: Template = TemplateSchema.parse({
  ...base,
  id: 'content-publishing',
  kind: 'crew',
  title: 'Content & Publishing',
  category: 'Content',
  summary: 'Go from audience questions to ready-to-review content.',
  bots: [tariq, hannah],
  handoff: ['Research an angle', 'Write drafts'],
});
const bot: Template = TemplateSchema.parse({
  ...base,
  id: 'bot-hannah',
  kind: 'bot',
  title: 'Hannah',
  category: 'Content',
  summary: hannah.summary,
  bots: [hannah],
  handoff: [],
  memberOf: ['Content & Publishing'],
});
const server = (status: McpServerSummary['status']) =>
  ({ id: 'cm0server000000000000000', slug: 'notion', status }) as McpServerSummary;

describe('Templates library (D-229)', () => {
  it('filters by kind, category and every search word', () => {
    const all = [crew, bot];
    const state = { kind: 'crew', query: '', category: '' } as const;
    expect(visibleTemplates(all, state)).toEqual([crew]);
    expect(visibleTemplates(all, { ...state, kind: 'bot', query: 'social writer' })).toEqual([bot]);
    expect(visibleTemplates(all, { ...state, query: 'writer unicorn' })).toEqual([]);
    expect(visibleTemplates(all, { ...state, category: 'Sales' })).toEqual([]);
  });

  it('says what each supported tool needs, and admits when it could not check', () => {
    const read: Connections = { servers: [], directory: [], directoryRead: true };
    expect(toolState('notion', { ...read, servers: [server('CONNECTED')] })).toBe('connected');
    expect(toolState('notion', { ...read, servers: [server('NEEDS_REAUTH')] })).toBe('reconnect');
    expect(
      toolState('notion', {
        ...read,
        directory: [
          { name: 'Notion', slug: 'notion', category: null, iconUrl: null, authType: 'OAUTH2' },
        ],
      }),
    ).toBe('available');
    expect(toolState('notion', read)).toBe('unavailable');
    expect(toolState('notion', NO_CONNECTIONS)).toBe('unknown');
  });

  it('opens a bot template as an editable profile, and a crew as nothing of the kind', () => {
    expect(draftFromTemplate(bot)).toEqual({
      name: 'Hannah',
      role: 'Demand Gen & Social Writer',
      systemPrompt: 'You write sharp, concrete content.',
      avatarColor: '#d6336c',
      avatarShape: 'cloud',
    });
    expect(draftFromTemplate(crew)).toBeNull();
  });

  it('carries a brief Crewaid drafted into setup, and nothing when there was none', () => {
    expect(prefillFrom({ templateId: 'x', goal: ' Publish weekly ' })).toEqual({
      goal: 'Publish weekly',
      context: '',
    });
    expect(prefillFrom({ templateId: 'x' })).toBeUndefined();
    expect(prefillFrom('not an object')).toBeUndefined();
  });

  it('lists crews by their roles and bots by the crews they belong to', () => {
    const crews = renderToStaticMarkup(
      <TemplateBrowse
        templates={[crew, bot]}
        state={{ kind: 'crew', query: '', category: '' }}
        onChange={() => undefined}
        onOpen={() => undefined}
      />,
    );
    expect(crews).toContain('Signal &amp; Trend Hunter · Demand Gen &amp; Social Writer');
    expect(crews).not.toContain('Also in');
    const bots = renderToStaticMarkup(
      <TemplateBrowse
        templates={[crew, bot]}
        state={{ kind: 'bot', query: '', category: '' }}
        onChange={() => undefined}
        onOpen={() => undefined}
      />,
    );
    expect(bots).toContain('Also in Content &amp; Publishing');
  });

  it('keeps a failed setup recoverable and says retrying adds nobody twice', () => {
    const html = renderToStaticMarkup(
      <CrewSetup
        template={crew}
        connections={NO_CONNECTIONS}
        draft={{ goal: 'Publish weekly', context: '', serverIds: [] }}
        onChange={() => undefined}
        busy={false}
        failed
        onBack={() => undefined}
        onAdd={() => undefined}
        onConnect={() => undefined}
      />,
    );
    expect(html).toContain('We couldn’t add this crew.');
    expect(html).toContain('won’t add anyone');
    expect(html).toContain('Try again');
    expect(html).toContain('No routines scheduled');
  });

  it('renders a recommendation card and ignores output that is not a template', () => {
    expect(renderToStaticMarkup(<TemplateResultCard output={crew} />)).toContain(
      'Content &amp; Publishing',
    );
    expect(renderToStaticMarkup(<TemplateResultCard output={{ token: 'nope' }} />)).toBe('');
  });
});

describe('Crewaid welcome and settings (D-229, D-232)', () => {
  const said = (author: 'USER' | 'BOT', text: string, id = text): TranscriptMessage => ({
    id,
    author,
    parts: [{ type: 'text', text }],
    timeLabel: '9:00 AM',
    createdAt: 0,
  });
  const greeting = WELCOME_COPY.greeting('Natanael').map((line) => said('BOT', line));

  it('opens the thread with Crewaid’s own mascot, waving only while the welcome is open', () => {
    const bot = { name: 'Crewaid', avatarColor: '#4c6ef5', avatarShape: 'egg' } as const;
    const open = renderToStaticMarkup(<WelcomeOpening bot={bot} greeting />);
    expect(open).toContain('Welcome');
    expect(open).toContain('Every task, crew and result starts here.');
    expect(open).toContain('data-mascot-shape="egg"');
    expect(open).toContain('data-activity="greeting"');
    expect(renderToStaticMarkup(<WelcomeOpening bot={bot} greeting={false} />)).not.toContain(
      'data-activity="greeting"',
    );
  });

  it('offers replies under Crewaid’s greeting, and drops the tour once it is given', () => {
    expect(welcomeOffer(true, greeting)).toEqual({
      kind: 'replies',
      replies: ['TASK', 'CREW', 'TOUR'],
    });
    const toured = [
      ...greeting,
      said('USER', WELCOME_COPY.replies.TOUR),
      said('BOT', WELCOME_COPY.guide),
      said('BOT', WELCOME_COPY.afterGuide),
    ];
    expect(welcomeOffer(true, toured)).toEqual({ kind: 'replies', replies: ['TASK', 'CREW'] });
    // Nothing to tap while the person's own message waits for an answer.
    expect(welcomeOffer(true, [...greeting, said('USER', 'Plan my week')])).toBeNull();
    const html = renderToStaticMarkup(
      <WelcomeReplies replies={['TASK', 'CREW', 'TOUR']} onReply={() => Promise.resolve()} />,
    );
    for (const reply of Object.values(WELCOME_COPY.replies)) expect(html).toContain(reply);
  });

  it('shows starting points under Crewaid’s question until anything else is said', () => {
    const asked = [
      ...greeting,
      said('USER', WELCOME_COPY.replies.TASK),
      said('BOT', WELCOME_COPY.taskQuestion),
    ];
    expect(welcomeOffer(false, asked)).toEqual({ kind: 'starting-points' });
    expect(welcomeOffer(false, [...asked, said('USER', 'Plan my week')])).toBeNull();
    expect(welcomeOffer(false, greeting)).toBeNull();
    const html = renderToStaticMarkup(<StartingPoints onCompose={() => undefined} />);
    for (const task of exampleTasks()) expect(html).toContain(task);
  });

  it('locks the main assistant’s name and label and asks for working preferences instead', () => {
    const draft = {
      name: 'Crewaid',
      role: 'Main assistant',
      systemPrompt: '',
      avatarColor: '#4c6ef5',
      avatarShape: 'egg',
    } as const;
    const main = renderToStaticMarkup(
      <BotFields draft={draft} onChange={() => undefined} idPrefix="t" mainAssistant />,
    );
    expect(main).toContain('How Crewaid should work with you');
    expect(main).not.toContain('id="t-name"');
    expect(main).not.toContain('id="t-role"');
    const ordinary = renderToStaticMarkup(
      <BotFields draft={draft} onChange={() => undefined} idPrefix="t" />,
    );
    expect(ordinary).toContain('id="t-name"');
    expect(ordinary).toContain('Description');
  });
});
