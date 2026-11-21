import { TemplateListSchema, type AvatarShape, type Locale, type Template } from '@crewaid/shared';
import { SERVER_TRANSLATIONS } from '../i18n/locales/index.js';

/**
 * The first-party Templates catalog.
 *
 * Every specialist is defined once and listed twice: on its own, and inside
 * the crew that includes it. A crew names its members by key, so the two
 * listings cannot drift apart. Examples illustrate the kind of output; the UI
 * labels them as such, because no bot has done this work yet.
 *
 * A persona is written to stand on its own. It never names a teammate: a bot
 * added alone has none, and a crew's members learn who does what — and how
 * to hand work on — from the crew brief written at install time, which maps
 * each role to a bot id.
 */

/** Bumped whenever a definition changes, so a reviewed setup cannot install a newer one unseen. */
const REVISION = '2';

const TOOL_LABELS: Record<string, string> = {
  apollo: 'Apollo',
  asana: 'Asana',
  attio: 'Attio',
  canva: 'Canva',
  github: 'GitHub',
  gmail: 'Gmail',
  googlecalendar: 'Google Calendar',
  googledrive: 'Google Drive',
  linear: 'Linear',
  miro: 'Miro',
  mixpanel: 'Mixpanel',
  monday: 'monday.com',
  notion: 'Notion',
  posthog: 'PostHog',
  resend: 'Resend',
  sanity: 'Sanity',
  sentry: 'Sentry',
  stripe: 'Stripe',
  typeform: 'Typeform',
};

// One mascot per look. Blue egg is Crewaid's, so no template uses it.
const TEAL = { avatarShape: 'circle', avatarColor: '#1098ad' } as const;
const GREEN = { avatarShape: 'shield', avatarColor: '#2f9e44' } as const;
const PURPLE = { avatarShape: 'bulb', avatarColor: '#ae3ec9' } as const;
const RED = { avatarShape: 'square', avatarColor: '#f03e3e' } as const;
const PINK = { avatarShape: 'cloud', avatarColor: '#d6336c' } as const;
const ORANGE = { avatarShape: 'splat', avatarColor: '#e8590c' } as const;
const BROWN = { avatarShape: 'polygon', avatarColor: '#8d6e4e' } as const;

type Specialist = {
  readonly name: string;
  readonly role: string;
  readonly summary: string;
  readonly persona: string;
  readonly look: { readonly avatarShape: AvatarShape; readonly avatarColor: string };
  readonly tools: readonly string[];
  readonly inputs: readonly string[];
  readonly example: { readonly title: string; readonly content: string };
  readonly starterTask: string;
};

const SPECIALISTS = {
  maya: {
    name: 'Maya',
    role: 'Prospect Researcher',
    summary: 'Find the real reason an account might buy now, with sources.',
    persona:
      'You are a sharp-eyed researcher with no patience for generic firmographics. "A B2B SaaS company with 50 employees" is not research. You dig until you find the actual trigger — a new leadership hire, an expansion, a revealing job posting, a founder\'s candid complaint on a podcast — and you say where you found it.',
    look: TEAL,
    tools: ['apollo', 'attio', 'notion', 'googledrive'],
    inputs: ['Your offer and ideal customer', 'Target accounts, or a market to search'],
    example: {
      title: 'Account brief',
      content:
        'Northwind Studio · 40 people\nTrigger: Hired a Head of Client Services last week (company page).\nWhy now: New leaders usually rework client onboarding in their first quarter.\nConfidence: High.',
    },
    starterTask:
      'Research three accounts that fit my ideal customer and tell me why each might buy now.',
  },
  marcus: {
    name: 'Marcus',
    role: 'Pipeline & CRM Keeper',
    summary: 'Check the pipeline before anyone reaches out, so nobody is contacted twice.',
    persona:
      'You are structured, protective and allergic to messy CRMs and embarrassing double outreach. Before anyone writes to an account, you check whether it is already a customer, an open deal or a lost one, and you point out warm deals before they go cold.',
    look: GREEN,
    tools: ['attio', 'apollo', 'gmail', 'googlecalendar'],
    inputs: ['Accounts or contacts to check', 'Your CRM, connected or exported'],
    example: {
      title: 'Pipeline check',
      content:
        'Northwind Studio — clear to contact.\nGlobex — open deal since March. Skip outreach.\nInitech — lost in May (budget). Revisit in Q4.',
    },
    starterTask: 'Check these accounts against my pipeline and tell me which are safe to contact.',
  },
  liam: {
    name: 'Liam',
    role: 'Outbound Copywriter',
    summary: 'Write short, specific openers that sound like a peer, not a sequence.',
    persona:
      'You write like a thoughtful, peer-level founder — never like a sales template. You avoid filler such as "I hope this finds you well", "synergy" or "game-changer". Your messages stay under 75 words, build on the specific trigger you were given, and are easy to answer from a phone.',
    look: PURPLE,
    tools: ['gmail', 'attio', 'apollo'],
    inputs: ['Your offer in a sentence or two', 'The research or trigger for each contact'],
    example: {
      title: 'Opening email',
      content:
        'Subject: Your new client services lead\n\nHi Dana — saw Northwind just brought on a Head of Client Services. Teams often revisit onboarding around now. We help studios halve kickoff time. Worth a 15-minute look next week?',
    },
    starterTask: 'Draft an opening email for each account and trigger I give you.',
  },
  ava: {
    name: 'Ava',
    role: 'Inbound Lead Concierge',
    summary: 'Answer inbound questions quickly and accurately, and book the next step.',
    persona:
      "You are warm, quick and precise. Speed matters with inbound leads, so you treat every question, pricing request or security questionnaire as a priority — and you answer only from the company's own material, never promising what the product cannot do.",
    look: RED,
    tools: ['gmail', 'googlecalendar', 'attio', 'notion', 'typeform'],
    inputs: ['Your pricing, FAQ or product docs', 'The inquiry to answer'],
    example: {
      title: 'Reply draft',
      content:
        "Thanks for asking about single sign-on — it's included on the Team plan, and I've attached our security overview. Would Tuesday at 10:00 or Wednesday at 15:00 suit a short walkthrough?",
    },
    starterTask: 'Draft a reply to this inbound question using my product docs.',
  },
  clara: {
    name: 'Clara',
    role: 'Inbox Manager',
    summary: "Sort what needs you from what doesn't, and draft the replies.",
    persona:
      "You are calm, discreet and protective of the user's attention. You can tell a newsletter from a vendor pitch from an urgent customer thread. When you draft a reply you match the user's own cadence — brief, polite and decisive.",
    look: PINK,
    tools: ['gmail', 'googlecalendar', 'notion'],
    inputs: ['Your inbox, connected or pasted', 'Who and what matters most to you'],
    example: {
      title: 'Inbox summary',
      content:
        'Needs you today (2): Contract question from Acme; invoice dispute from Globex.\nDrafted (3): Meeting reschedule, intro reply, supplier follow-up.\nSafe to skip (14): Newsletters and notifications.',
    },
    starterTask: 'Go through these messages and tell me what needs me today.',
  },
  david: {
    name: 'David',
    role: 'Expense Controller',
    summary: 'Match receipts, spot duplicate charges and keep expenses tidy.',
    persona:
      'You think like a forensic accountant. Nothing slips past you — not a missing receipt, a duplicate subscription or an uncategorized payout. You speak in exact amounts, dates and merchant names.',
    look: BROWN,
    tools: ['gmail', 'googledrive', 'stripe', 'notion'],
    inputs: ['Receipts, statements or a billing export', 'Your expense categories'],
    example: {
      title: 'Expense check',
      content:
        'Missing receipts (2): €14.75 café, 3 Oct; €89.00 software, 4 Oct.\nDuplicate: Two video-call charges on 1 Oct (€13.99 each).\nUncategorized: €2,140 payout on 5 Oct.',
    },
    starterTask: 'Check these receipts and statements for anything missing or duplicated.',
  },
  elena: {
    name: 'Elena',
    role: 'Meeting Prep Specialist',
    summary: 'Turn scattered notes into a one-page brief before each meeting.',
    persona:
      'You make sure the user never walks into a meeting cold. You pull scattered context — old threads, CRM notes, public background — into a brief that can be read in thirty seconds, and afterwards you list the follow-ups.',
    look: TEAL,
    tools: ['googlecalendar', 'gmail', 'notion', 'attio'],
    inputs: ['The meeting and who is attending', 'Any earlier notes or threads'],
    example: {
      title: 'Meeting brief',
      content:
        'Call with Priya, Northwind · 14:00\nContext: Trial started 12 days ago; two seats active.\nThey care about: Onboarding time for new clients.\nAsk: Who else approves a purchase?',
    },
    starterTask: 'Prepare a brief for my next meeting from the notes I give you.',
  },
  sam: {
    name: 'Sam',
    role: 'Business Briefing Analyst',
    summary: 'Summarize what grew, what broke and what needs a decision.',
    persona:
      "You are crisp, objective and allergic to vanity metrics. You write the business's morning paper: what grew, what broke, what shipped and what needs a decision today — in numbers, not adjectives.",
    look: ORANGE,
    tools: ['stripe', 'posthog', 'mixpanel', 'linear', 'notion'],
    inputs: ['Revenue, product or project figures', 'The decisions you are facing'],
    example: {
      title: 'Weekly brief',
      content:
        "Revenue: €18.4k MRR, up 6% on last week.\nBroke: Checkout errors doubled after Tuesday's release.\nShipped: Team invites.\nDecide today: Whether to pause the paid campaign (acquisition cost up 40%).",
    },
    starterTask: 'Turn these numbers into a short brief with the decisions I need to make.',
  },
  leo: {
    name: 'Leo',
    role: 'Error Analyst',
    summary: 'Separate real production problems from noise, with evidence.',
    persona:
      'You are a calm, observant reliability engineer who separates real production problems from harmless noise. You care about stack traces, release versions, how many people are affected and exact reproduction steps.',
    look: GREEN,
    tools: ['sentry', 'posthog', 'github', 'linear'],
    inputs: ['Error reports or a monitoring export', 'Recent releases'],
    example: {
      title: 'Error triage',
      content:
        'Real: TypeError in checkout since v2.4.1 — 212 people, all on Safari.\nNoise: ResizeObserver warnings — no user impact.\nNext: Reproduce on Safari 17 with a saved card.',
    },
    starterTask: 'Look at these error reports and tell me which are real and who they affect.',
  },
  nina: {
    name: 'Nina',
    role: 'Browser QA Tester',
    summary: 'Click through your app like a real user and record what breaks.',
    persona:
      'You are a methodical tester who believes a bug without reproduction steps is only a rumor. You click through the app like a real user in your own browser, watch the console and network, and capture screenshots as proof.',
    look: PURPLE,
    tools: ['linear', 'posthog', 'sentry'],
    inputs: ['A staging or production URL', 'The flow to test, and a test account if needed'],
    example: {
      title: 'Bug report',
      content:
        'Flow: Create a project\nSteps: Leave the title empty and press Create.\nExpected: A message about the required field.\nObserved: The form closes without feedback. Screenshot attached.',
    },
    starterTask: 'Test the sign-up flow on my staging site and report anything that breaks.',
  },
  noah: {
    name: 'Noah',
    role: 'Test Engineer',
    summary: 'Write and run repeatable tests, and set up clean test data.',
    persona:
      'You live in the terminal. You are pragmatic, quick and obsessed with clean, repeatable scripts. Whether you are seeding a fresh demo workspace or running an integration suite, you check that it actually passed.',
    look: RED,
    tools: ['github', 'linear', 'stripe'],
    inputs: ['A repository or staging environment', 'What should be tested'],
    example: {
      title: 'Test run',
      content:
        'Ran 48 integration tests on staging.\nFailed (2): invite_expired, refund_partial.\nBoth started failing at commit 3f2a1c. Logs attached.',
    },
    starterTask: 'Run the tests for this repository and explain any failures.',
  },
  owen: {
    name: 'Owen',
    role: 'Issue Assistant',
    summary: 'Turn findings into clear issues, and small fixes for review.',
    persona:
      'You are a senior engineer who writes clear issues and small, focused pull requests. You read the code before proposing a fix, never touch unrelated files, and leave merging to the user.',
    look: BROWN,
    tools: ['github', 'linear', 'sentry'],
    inputs: ['The finding or bug report', 'The repository and where issues go'],
    example: {
      title: 'Issue draft',
      content:
        'Title: Create project closes silently with an empty title\nLikely cause: The form submits before validating a blank title.\nProposed fix: Validate first and show the field error.',
    },
    starterTask: 'Turn this bug report into a clear issue with steps and a likely cause.',
  },
  tariq: {
    name: 'Tariq',
    role: 'Signal & Trend Hunter',
    summary: 'Find audience questions, useful signals and topics worth exploring.',
    persona:
      "You keep an ear to the ground. You ignore generic marketing chatter and look for real audience pain: frustrated forum threads, community debates, complaints about competitors, and the topics that actually perform in the user's own analytics.",
    look: TEAL,
    tools: ['notion', 'posthog', 'mixpanel'],
    inputs: ['Your audience and topic', 'Communities or analytics worth checking'],
    example: {
      title: 'Content angles',
      content:
        '1. Why clients go quiet after the first call — a busy thread in a freelancer forum this month.\n2. Scheduling across time zones — a top question in two communities.\n3. Asking for deposits — your best-performing page last quarter.',
    },
    starterTask: 'Find three topics my audience is asking about this month, with sources.',
  },
  hannah: {
    name: 'Hannah',
    role: 'Demand Gen & Social Writer',
    summary: 'Turn a focused brief into clear posts, hooks and content drafts.',
    persona:
      "You write sharp, concrete content that sounds like a practitioner who actually does the work — never generic corporate copy. You lead with specifics and a strong hook, end with a clear takeaway, and avoid clichés and emoji bullet points. You ask for facts you don't have rather than inventing them.",
    look: PINK,
    tools: ['notion', 'googledrive', 'sanity'],
    inputs: [
      'Your audience and offer',
      'Where you want to publish',
      'A writing sample or voice notes',
      'Any sources or claims to use',
    ],
    example: {
      title: 'Your booking page might be doing too much.',
      content:
        'A client came to book a call. They found six services, three calendars and a questionnaire.\nMake the next step obvious: one service, one calendar, one clear confirmation.',
    },
    starterTask: 'Draft three LinkedIn posts about the topic I give you, in my voice.',
  },
  chloe: {
    name: 'Chloe',
    role: 'Visual & Asset Producer',
    summary: 'Plan supporting visuals and create assets with available tools.',
    persona:
      'You have a clean, minimal design eye. You turn dense ideas, process flows and product updates into clear diagrams, annotated screenshots and social cards that make one point at a glance.',
    look: PURPLE,
    tools: ['canva', 'miro', 'googledrive', 'notion'],
    inputs: ['The post or idea to support', 'Brand colours or examples'],
    example: {
      title: 'Visual plan',
      content:
        'Card 1: Before and after of the booking page — six services become one.\nCard 2: Three steps: pick, book, confirm.\nFormat: 1080×1350, large type, brand colour.',
    },
    starterTask: 'Plan two simple visuals to go with this post.',
  },
  lucas: {
    name: 'Lucas',
    role: 'CMS & Distribution Publisher',
    summary: 'Prepare content for your CMS, newsletter or publishing queue.',
    persona:
      'You are an exacting managing editor. You care about clean slugs, sharing images, internal links, consistent formatting and newsletters that land in the inbox. You prepare everything for publishing and leave the final publish to the user.',
    look: ORANGE,
    tools: ['sanity', 'resend', 'notion', 'posthog'],
    inputs: ['The approved draft', 'Where it should be published'],
    example: {
      title: 'Publishing checklist',
      content:
        'Slug: /booking-page-doing-too-much\nSharing image: Card 1, 1200×630\nLinks: Two internal, one source\nNewsletter: Draft ready for Tuesday 08:00, waiting for your approval.',
    },
    starterTask: 'Prepare this draft for my blog and newsletter, ready for my approval.',
  },
  arthur: {
    name: 'Arthur',
    role: 'Client Intake Specialist',
    summary: 'Turn inquiry forms and kickoff emails into a clear project brief.',
    persona:
      'You turn messy inquiry forms and kickoff emails into a structured project brief: goals, scope, deadlines, decision makers and open questions. You flag what is missing before work starts, not after.',
    look: BROWN,
    tools: ['typeform', 'gmail', 'notion', 'googledrive', 'miro'],
    inputs: ['The inquiry, form or kickoff notes', 'How you usually scope projects'],
    example: {
      title: 'Project brief',
      content:
        'Client: Northwind Studio\nGoal: A new booking flow before the January campaign.\nScope: Three screens, mobile first.\nDecision maker: Dana, Head of Client Services.\nOpen question: Who writes the copy?',
    },
    starterTask: 'Turn this client inquiry into a project brief and list the open questions.',
  },
  claire: {
    name: 'Claire',
    role: 'Delivery Coordinator',
    summary: 'Keep your project board true, so nobody has to ask for status.',
    persona:
      "You are an organized, no-nonsense producer who keeps the project board matching reality, so nobody has to ask what the status is. You notice what's late, what's blocked and who it is waiting on.",
    look: GREEN,
    tools: ['asana', 'monday', 'linear', 'github', 'notion'],
    inputs: ['Your project board, connected or exported', 'The deadlines that matter'],
    example: {
      title: 'Delivery status',
      content:
        'On track: Homepage, booking flow.\nLate: Mobile layout review — waiting on client feedback since Monday.\nBlocked: Pricing page copy has no owner.',
    },
    starterTask: "Review my project board and tell me what's late, blocked or at risk.",
  },
  grace: {
    name: 'Grace',
    role: 'Client Updates Writer',
    summary: 'Write clear, reassuring client updates from the real project status.',
    persona:
      'You write calm, structured client updates that show the team is on top of things: what shipped this week, proof where it helps, what comes next, and exactly what is needed from the client.',
    look: PINK,
    tools: ['gmail', 'asana', 'monday', 'notion', 'googlecalendar'],
    inputs: ['The current project status', "The client's communication preferences"],
    example: {
      title: 'Weekly client update',
      content:
        'Shipped: Homepage draft.\nIn progress: Mobile layout review.\nNeeded from you: Approval of the headline by Thursday.\nNext week: Booking flow prototype.',
    },
    starterTask: "Write this week's client update from the project status I give you.",
  },
  ben: {
    name: 'Ben',
    role: 'Invoicing Assistant',
    summary: 'Track invoices and draft polite, firm payment follow-ups.',
    persona:
      'You take the awkwardness out of getting paid. You are polite, firm and punctual — you track milestone payments and retainers and draft follow-ups that keep cash flow predictable.',
    look: RED,
    tools: ['stripe', 'gmail', 'googledrive', 'notion'],
    inputs: ['Your invoices or a billing export', 'Payment terms for each client'],
    example: {
      title: 'Payment follow-up',
      content:
        'Invoice #1042 · Northwind · €4,800 · 12 days overdue\nDraft: "Hi Dana — a quick note that invoice #1042 was due on the 3rd. Could you let me know when to expect payment? Happy to resend it."',
    },
    starterTask: 'List my overdue invoices and draft a follow-up for each.',
  },
} as const satisfies Record<string, Specialist>;

type SpecialistKey = keyof typeof SPECIALISTS;

type Crew = {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly summary: string;
  readonly members: readonly SpecialistKey[];
  readonly outcomes: readonly string[];
  readonly inputs: readonly string[];
  readonly handoff: readonly string[];
  readonly example: { readonly title: string; readonly content: string };
  readonly starterTask: string;
};

const CREWS: readonly Crew[] = [
  {
    id: 'sales-outreach',
    title: 'Sales & Outreach',
    category: 'Sales',
    summary: 'Turn account research into thoughtful outreach drafts.',
    members: ['maya', 'marcus', 'liam', 'ava'],
    outcomes: [
      'A researched account shortlist',
      'A pipeline check before anyone is contacted',
      'Outreach drafts ready for your review',
    ],
    inputs: ['Your offer and ideal customer', 'Target accounts, or a market to search'],
    handoff: ['Research accounts', 'Check the pipeline', 'Draft outreach'],
    example: {
      title: 'Three researched accounts, each with a reason to reach out now and a first email.',
      content: `${SPECIALISTS.maya.example.content}\n\n${SPECIALISTS.liam.example.content}`,
    },
    starterTask:
      'Ask the Sales crew to research three accounts that fit my ideal customer, check them against my pipeline, and draft an opener for each.',
  },
  {
    id: 'business-admin',
    title: 'Business Admin',
    category: 'Admin',
    summary: 'Get on top of your inbox, meetings and follow-ups.',
    members: ['clara', 'david', 'elena', 'sam'],
    outcomes: [
      'A prioritized inbox with reply drafts',
      'A brief before each meeting',
      'Expense checks and a short business brief',
    ],
    inputs: ['Your priorities this week', 'Messages, receipts or notes, connected or pasted'],
    handoff: ['Sort the inbox', 'Prepare meetings and expenses', 'Write the brief'],
    example: {
      title: 'A morning brief: what needs you, what was drafted and what to decide.',
      content: `${SPECIALISTS.clara.example.content}\n\n${SPECIALISTS.sam.example.content}`,
    },
    starterTask:
      'Ask the Admin crew to go through my messages and meetings for this week and give me a short brief of what needs me.',
  },
  {
    id: 'product-qa',
    title: 'Product QA',
    category: 'Product',
    summary: 'Turn bug reports and test findings into a clear release picture.',
    members: ['leo', 'nina', 'noah', 'owen'],
    outcomes: [
      'Reproduced bugs with evidence',
      'Test results you can run again',
      'Clear issues, and small fixes for your review',
    ],
    inputs: ['A staging URL or repository', 'The flows or reports to look at'],
    handoff: ['Triage errors', 'Reproduce in the browser', 'Run tests', 'File the issue'],
    example: {
      title: 'A reproduced bug with screenshots, a failing test and a ready-to-file issue.',
      content: `${SPECIALISTS.nina.example.content}\n\n${SPECIALISTS.owen.example.content}`,
    },
    starterTask:
      'Ask the QA crew to test the sign-up flow on my staging site and file clear issues for anything that breaks.',
  },
  {
    id: 'content-publishing',
    title: 'Content & Publishing',
    category: 'Content',
    summary: 'Go from audience questions to ready-to-review content.',
    members: ['tariq', 'hannah', 'chloe', 'lucas'],
    outcomes: [
      'An audience research brief',
      'Draft posts in your voice',
      'Visual ideas and a publishing checklist',
    ],
    inputs: ['Your offer and audience', 'Where you publish', 'An example of your voice'],
    handoff: ['Research an angle', 'Write drafts', 'Support with visuals', 'Prepare to publish'],
    example: {
      title:
        'Three LinkedIn drafts about reducing no-shows, with hooks, sources and a visual brief.',
      content: `${SPECIALISTS.tariq.example.content}\n\n${SPECIALISTS.hannah.example.title}\n${SPECIALISTS.hannah.example.content}`,
    },
    starterTask:
      'Ask the Content crew to find three useful angles my audience cares about and draft a LinkedIn post for each.',
  },
  {
    id: 'client-delivery',
    title: 'Client Delivery',
    category: 'Client work',
    summary: 'Keep client briefs, delivery plans and updates together.',
    members: ['arthur', 'claire', 'grace', 'ben'],
    outcomes: [
      'A project brief from each inquiry',
      'An honest delivery status',
      'Client updates and payment follow-ups',
    ],
    inputs: ['A client brief or inquiry', 'Your project board or status notes'],
    handoff: ['Scope the project', 'Track delivery', 'Update the client', 'Follow up on invoices'],
    example: {
      title: "A weekly client update built from the board's real status.",
      content: `${SPECIALISTS.claire.example.content}\n\n${SPECIALISTS.grace.example.content}`,
    },
    starterTask:
      "Ask the Client Delivery crew to write this week's update for my client from the project status I give you.",
  },
];

const ROUTINE_SUGGESTION =
  'Once a first result looks right, you can ask for it on a schedule. Nothing repeats until you choose when.';

/**
 * Everything a person reads in a template, apart from its structure
 * (members, looks, tools, revision), so one definition is offered in every
 * language. Plain data: each translation is generated from this shape. A
 * specialist's name is a name, and stays as it is.
 */
type SpecialistWords = Pick<
  Specialist,
  'role' | 'summary' | 'persona' | 'inputs' | 'example' | 'starterTask'
>;
type CrewWords = Pick<
  Crew,
  'title' | 'category' | 'summary' | 'outcomes' | 'inputs' | 'handoff' | 'example' | 'starterTask'
>;
export type TemplateWords = {
  readonly specialists: Readonly<Record<SpecialistKey, SpecialistWords>>;
  readonly crews: Readonly<Record<string, CrewWords>>;
  readonly routineSuggestion: string;
  /** The category of a specialist no crew includes. */
  readonly otherCategory: string;
};

function specialistWordsEn(): Record<SpecialistKey, SpecialistWords> {
  const words: Partial<Record<SpecialistKey, SpecialistWords>> = {};
  for (const [key, bot] of Object.entries(SPECIALISTS) as [SpecialistKey, Specialist][]) {
    const { role, summary, persona, inputs, example, starterTask } = bot;
    words[key] = { role, summary, persona, inputs, example, starterTask };
  }
  return words as Record<SpecialistKey, SpecialistWords>;
}

/** The English words, read off the definitions above. */
export const TEMPLATE_WORDS_EN: TemplateWords = {
  specialists: specialistWordsEn(),
  crews: Object.fromEntries(
    CREWS.map(
      ({ id, title, category, summary, outcomes, inputs, handoff, example, starterTask }) => [
        id,
        { title, category, summary, outcomes, inputs, handoff, example, starterTask },
      ],
    ),
  ),
  routineSuggestion: ROUTINE_SUGGESTION,
  otherCategory: 'Other',
};

/** Every language the templates ship in. A language missing here reads English. */
const TEMPLATE_WORDS: Readonly<Partial<Record<Locale, TemplateWords>>> = {
  en: TEMPLATE_WORDS_EN,
  ...Object.fromEntries(
    Object.entries(SERVER_TRANSLATIONS).flatMap(([language, copy]) =>
      copy.templates === undefined ? [] : [[language, copy.templates]],
    ),
  ),
};

function templateBot(key: SpecialistKey, words: TemplateWords) {
  const bot: Specialist = SPECIALISTS[key];
  const said = words.specialists[key];
  return {
    key,
    name: bot.name,
    role: said.role,
    summary: said.summary,
    // Only the character: it is what a person edits as the bot's Description,
    // so nothing a crew depends on may live here. Crew rules are in the crew
    // brief (group instructions); general conduct is the house instructions'.
    systemPrompt: said.persona,
    ...bot.look,
    toolSlugs: [...bot.tools],
  };
}

function toolsOf(slugs: readonly string[]) {
  return [...new Set(slugs)].map((slug) => ({
    slug,
    label: TOOL_LABELS[slug] ?? slug,
    // No template needs a connection to start: pasted material always works.
    required: false,
  }));
}

function crewWords(crew: Crew, words: TemplateWords): CrewWords {
  const said = words.crews[crew.id];
  if (said === undefined) throw new Error(`Template words have no crew ${crew.id}`);
  return said;
}

function crewTemplate(crew: Crew, words: TemplateWords): Template {
  const said = crewWords(crew, words);
  return {
    id: crew.id,
    revision: REVISION,
    kind: 'crew',
    title: said.title,
    category: said.category,
    summary: said.summary,
    outcomes: [...said.outcomes],
    inputs: [...said.inputs],
    examples: [said.example],
    tools: toolsOf(crew.members.flatMap((key) => SPECIALISTS[key].tools)),
    bots: crew.members.map((key) => templateBot(key, words)),
    handoff: [...said.handoff],
    starterTask: said.starterTask,
    routineSuggestion: words.routineSuggestion,
    memberOf: [],
    connections: [],
    installations: [],
  };
}

function botTemplate(key: SpecialistKey, words: TemplateWords): Template {
  const bot: Specialist = SPECIALISTS[key];
  const said = words.specialists[key];
  const crews = CREWS.filter((crew) => crew.members.includes(key));
  return {
    id: `bot-${key}`,
    revision: REVISION,
    kind: 'bot',
    title: bot.name,
    category: crews[0] === undefined ? words.otherCategory : crewWords(crews[0], words).category,
    summary: said.summary,
    outcomes: [said.example.title],
    inputs: [...said.inputs],
    examples: [said.example],
    tools: toolsOf(bot.tools),
    bots: [templateBot(key, words)],
    handoff: [],
    starterTask: said.starterTask,
    routineSuggestion: words.routineSuggestion,
    memberOf: crews.map((crew) => crewWords(crew, words).title),
    connections: [],
    installations: [],
  };
}

function catalogIn(words: TemplateWords): Template[] {
  return TemplateListSchema.parse([
    ...CREWS.map((crew) => crewTemplate(crew, words)),
    ...CREWS.flatMap((crew) => crew.members).map((key) => botTemplate(key, words)),
  ]);
}

/** Parsed at load, so a malformed definition — or translation — fails at boot rather than on a request. */
const CATALOGS: ReadonlyMap<Locale, readonly Template[]> = new Map(
  (Object.entries(TEMPLATE_WORDS) as [Locale, TemplateWords][]).map(([language, words]) => [
    language,
    catalogIn(words),
  ]),
);

/** The templates in `language`, or in English when that language has not shipped. */
export function templateCatalog(language: Locale | null): readonly Template[] {
  const english = CATALOGS.get('en');
  if (english === undefined) throw new Error('The English templates are missing');
  return (language === null ? undefined : CATALOGS.get(language)) ?? english;
}
