# PRD — Work: projects, tasks, goals and deliverables

**Owner:** Natanael Exe / Evoxatech
**Status:** Ratified on 2026-09-23 by D-132 … D-140 (M10-AR-01). An **optional,
unopinionated** feature (§0.1). The §4 models, §5 routes and frames and §6 tool names are
contracts, carried in PRD §3.1 and §4. Where a decision differs from this text it wins: D-140
places Work at the foot of the sidebar and makes projects the views' scope picker (§7.1).
**Date:** 2026-09-23
**Milestone:** M10 — Work, worked before M9 (§9.6)

---

## 0. The problem, in the operator's words

> Day to day, the user gives bots tasks, has goals, and wants to check deliverables. Having to go
> through a conversation to find a document, a report, or who handled what and when is very
> tedious.

Today every unit of work in Crewaid is a **message**. A bot's conversation is the only place a
request, its progress, its outcome and its files exist. That works for one bot and one errand. It
stops working at the size this product is built for, which is several bots working side by side
(PRD §1.3). Here is what the operator cannot do today without scrolling transcripts:

| Question | Where the answer lives today |
|---|---|
| What is Backend working on right now? | Backend's transcript |
| What did Scout deliver last week? | Scattered attachment chips across Scout's transcript |
| Where is the PRD the PM wrote? | One of several transcripts, if it was attached. If not, a file on the volume |
| Who built the login page, and when? | Nowhere, unless you remember which bot to open |
| How far along is the MVP? | Nowhere. It is in the operator's head |
| Which scheduled routines serve that goal? | Nowhere. A routine is attached to a bot, not to a purpose |

This PRD adds four things, and only these four:

1. **Tasks**, optionally grouped by **project**, with **subtasks** that can go to different bots,
   and **recurring tasks** that come back on a schedule.
2. **A board** showing every task's state across bots.
3. **Goals** that collect the tasks and routines working toward one outcome.
4. **Deliverables** as first-class records, plus **search** across the whole app.

### 0.1 Optional and unopinionated

Everything in this PRD is **a place to keep track of work**, which the user and their bots can
read and write. It is not a workflow engine, and the app never acts on it by itself.

- **Chat stays the way work happens.** A bot never needs a task in order to work. A user who
  never opens Tasks keeps using Crewaid exactly as today: nothing new in the transcript, no badges,
  no rail sections, and no change in how bots answer.
- **The app does nothing on its own.** It never creates a task, never starts work because a
  task changed, never messages a bot about a task, and never closes, reopens or escalates
  anything. Every one of those things happens because the user did it on the board, or prompted
  a bot to do it. The one scheduled act is the one the user asked for: a **recurring task**
  puts its next occurrence on the board when its schedule says so, the way a routine fires.
  Even that starts no work.
- **No approval for acts that are not sensitive.** Bots message each other, and read and write
  tasks, without asking. A bot that sends another bot a message has a reason to. Approval is
  for what D-092 already reserves it for: destroying something, spending money, or acting as the
  user outside the sandbox (§9.5).
- **No team shape is built in.** There are no lead, manager or reviewer roles, no required
  notes, no approval step for Done, and no rule about which bot may change which task. The user
  can tell any bot to tell any other bot anything, and bots do that with `send_message`, which
  already exists. A "PM" is just a bot the user talks to that way.
- **Bots touch tasks when there is a reason.** A bot uses the task tools when the user asks it
  to, when the work it was given came from a task, or when another bot asked it to on the user's
  behalf. During complicated work a bot may **suggest** splitting it into tasks. It creates them
  only after the user says yes.
- **Deliverables and search are indexes, not workflow.** They record what bots already attach
  and what is already in conversations. They ask nothing of the user or the bots.
- **Not using it costs almost nothing.** No text is added to a bot's instructions. The task
  tools carry their own short guidance, inside a small token budget (§8).

### 0.2 The reference scenario

A user has a SaaS idea. The goal is an MVP. Every step below uses a tool that ships today or one
this PRD adds, and every step happens because the user asked for it.

| # | The user… | What happens | Uses |
|---|---|---|---|
| 1 | creates project *Acme SaaS* with goal *Ship the MVP*, or asks a bot to | A project and a goal appear on the board | board, or `project_create` |
| 2 | creates a PM bot | An ordinary bot | ships |
| 3 | asks the PM to create a frontend and a backend bot | `create_bot`. All three share one computer (D-046), so they share `/home/bot/shared`, where the code will live | ships |
| 4 | asks the PM to write a PRD | The PM writes `PRD.md` in the shared area and calls `attach_file` with the goal's ID. It becomes a deliverable on the goal, and the other bots can read it at the same path | `attach_file(..., goalId)` → deliverable |
| 5 | asks the PM to turn the PRD into tasks and assign them | `task_create` for each one, assigned to Frontend or Backend. All land in *To do*; nothing starts | `task_create` |
| 6 | asks the PM to get the team working one task at a time and to report back | The PM tells Backend "work on *API auth*" with `send_message({taskId})`. Backend receives a message linked to that task, reads it, does the work, attaches files and sets it to *Done*. Its files inherit the task link even when `attach_file` has no explicit `taskId`. It replies to the PM, and the PM moves on and reports in its own chat. The board updates live throughout | extended `send_message` (M7), `task_read`, `task_update` |
| 7 | asks the PM to verify the tasks marked done | The PM reads each task, its deliverables and the shared code. Where something is missing it sets the task back to *In progress* with a note and messages the bot | `task_read`, `fs_read`, `task_update`, `send_message` |
| 8 | checks in whenever they like | The board, grouped by bot, shows who is doing what. Each task's activity shows which bot changed what and when. Deliverables and search find the PRD and every report | §7 |

Nothing about "PM" is special to the app. The user could just as well tell Backend to ask
Frontend for something, or tell Frontend to update the PM's tasks. How work is handed around,
in what order, how often anyone reports, and what "verified" means are all in the user's
prompts. The app records what happened. It does not decide what should.

### 0.3 A personal goal: no project, recurring tasks, a routine

The user wants to lose weight.

| The user… | What exists |
|---|---|
| creates goal *Lose 8 kg by March* | A goal with **no project**. The goal itself groups everything below |
| adds "Work out", every Mon/Wed/Fri, unassigned | A **recurring task**. An occurrence appears in *To do* on each of those days. Unassigned means it is the user's own |
| adds "Log my weight", every morning | Another recurring task. The user ticks it off, and can put the number in the note ("82.4 kg") |
| adds routine: Coach bot, Sundays 8 pm, "look at my week and tell me how I did" | An ordinary M8 routine linked to the goal. On Sunday the coach calls `task_list` for the goal and that week's `occursOn` range, including completed and missed occurrences; it sees 3/3 workouts and 6/7 weigh-ins, and replies in its chat |
| later wants all health goals together | Creates project *Health* and moves the goal into it. Grouping is optional at every level |

The goal card shows how often each recurring task was done ("Work out 11/12, Log weight
25/28"). Nothing here needs a bot to start, and nothing starts a bot except the routine the user
set.

---

## 1. What already exists, and what it means for this design

Each row names a piece that already ships and how this PRD uses it, so nothing here gets built
twice.

| Already shipped | Where | What it gives us | Consequence for Work |
|---|---|---|---|
| One conversation per bot; `Message` rows with `parts` | PRD §3, M1 | The execution channel. A turn starts from a message | The board's **Start** button posts a brief into the assignee's conversation, the way the routine runner posts a routine's prompt. No second execution path |
| `send_message` with `chainId`/`hopCount` | M7, D-047 | Bots talking to bots, with accounting and operator-set ceilings | **This is how any bot tells another what to do.** Its optional task context is carried on the delivered message, without adding a delegation mechanism (§3.5) |
| `create_bot`, `schedule_routine` | M5, M8, D-125 | Bots create bots and schedule their own follow-ups | A bot can build a team and set its own check-ins when asked. Nothing new needed |
| One computer per user, `/home/bot/shared` (D-046, WORKSPACE §19) | M5 | Bots on a computer work on the same files | A bot asked to check another's work reads the shared files it already has access to |
| `attach_file` → `Attachment` claimed by the reply | M5-BE-06 | Bot-produced files, downloadable through `ApiClient.download()` (D-025) | **Every bot-attached file becomes a deliverable automatically.** Storage is unchanged. We add a record that points at it |
| Routines, with `origin` OPERATOR/BOT | M8 | Recurring work that posts a message on a schedule | A routine can belong to a **goal**. Anything its runs deliver counts toward that goal |
| `BOARD.md` and `board_read/add/update` | D-068 | A free-text notepad the bots on a computer share | **Kept.** It is the bots' own working notes; Tasks are the user's list. The two are worded apart (§9.2) |
| Transcript and memory FTS (`Message_content_fts_idx`, `Memory_text_fts_idx`) | D-073, D-077 | Postgres full-text search with `ts_headline` excerpts, indexes asserted from `pg_indexes` | **Global search reuses this machinery.** Same engine, same excerpt policy, same index assertions |
| D-073's reserved memory **project scope** | DECISIONS | "Lands … the first time a user can have two checkouts" | **A Work project is not that.** It groups tasks, not a checkout (§9.3) |
| Right rail that swaps content (`BotProfilePane`) | M2, M8, `App.tsx` | A "details of the selected thing" column | Task and goal details open in the rail. No new modal layer |
| Sidebar search filtering bots client-side | `BotSidebar.tsx` | The obvious place people type | It becomes the entry to **global search** (§7.6) |
| Ownership guard, route-coverage test, Prisma allowlist | D-010, D-026, R7 | Every new route and query is fenced by the build | Every new by-id route declares `@OwnedResource`; every query is scoped by `principal.userId` |
| `chatReducer` as the only frame → state door | CLAUDE.md | Exhaustive switch | All four new `*.changed` frames land there |

**The conclusion:** Work is **a data layer, a few tools and a set of views.** Its new runtime
behaviour is Start posting a brief, task tools reading and writing rows, task context passing
through bot messages, deliverables being filed with their attachments, and scheduled task occurrences
being created without starting work. A task turn is an ordinary turn, so approvals, limits,
memory, budgets and waking the computer apply unchanged.

---

## 2. Scope for v1

### 2.1 In v1 (P0: the milestone does not pass without it)

- **Projects.** Name, description, colour, active or archived. Any number can be active at once.
  A task with no project lives in **Inbox**.
- **Tasks** with title, brief, status, assignee (one bot, or unassigned), optional due date,
  project and goal.
- **Subtasks, one level deep**, each with its own assignee. The parent shows `3/5` progress.
- **Recurring tasks:** a task with a repeat schedule (the routine form's repeat choices) puts a
  fresh occurrence on the board each time it comes round (§3.6).
- **Start** (a user action): post the brief to the assignee's conversation and set
  *In progress*.
- **Board** with a column per status. The user drags cards. Filters: project, goal, bot.
  Group by bot answers "who is doing what".
- **Activity log per task:** every change, who made it (the user or which bot), when, and a link
  to the message it came from.
- **Bot tools:** list, read, create and update tasks, and create a project (§6).
- **Deliverables:** recorded automatically from `attach_file`, filed by provenance, browsable,
  previewable and downloadable.
- **Goals:** title, outcome text, target date, status, with or **without a project**. Tasks,
  recurring tasks and routines link to one goal. Progress is derived from its tasks.
- **Global search** over tasks, goals, projects, deliverables and every bot's transcript, with
  results that jump straight to the item.
- **Live updates:** when anyone changes a task, every open board shows it without a refresh.
  Open goal, project and deliverable views also refresh after their underlying records change
  (§5.2).

### 2.2 In v1, second half (P1: can slip to v1.1 without failing the gate)

- **`deliver_link`:** a bot records a non-file output as a deliverable, such as a Google Doc URL
  or a CRM record.
- **"Save as deliverable"** and **"Create task from message"** on any transcript message.
- **`schedule_routine` accepts a `goalId`.**
- **Cost per task and per goal:** summed tokens of the turns each one's messages triggered.
- **Text extraction for search** from text-like deliverables (`.md .txt .csv .json`).

### 2.3 Not in v1

| Not in v1 | Why not |
|---|---|
| Lead, manager or reviewer roles; bots notified about task changes; a verification workflow; restrictions on which bot may change which task; approval prompts for bot-to-bot messages or task edits | The app stays unopinionated (§0.1, §9.8). The user tells any bot to tell any other bot anything, and building one team shape into the product would be wrong for the next team |
| Any automatic task creation, starting or closing | Never. Tasks change because the user or a prompted bot changed them |
| Human assignees, teams, permissions | One operator (PRD §1.5). *Unassigned* is the operator's |
| Arbitrary nesting (sub-subtasks) | One level covers "split this across bots" |
| Task dependencies, Gantt, sprints, estimates, time tracking | Ordering is the board's `rank`. What happens in which order is up to whoever does the work, as the user directed |
| Custom statuses, columns or fields | A fixed status set is what lets bots and the board agree on meaning |
| Numeric key results, measurement charts, auto-evaluated goals | Progress from tasks plus the user marking a goal *Achieved*. A number (a weight, a count) can go in an occurrence's note. Tracking it as data is a later feature |
| Semantic/vector search, PDF/OCR extraction | Lexical FTS answers "find the PRD" in this corpus (D-077's reasoning). Revisit on evidence |
| Indexing the sandbox filesystem | A file never attached is not a deliverable. Indexing volumes would wake computers (WORKSPACE §8) |
| Comment threads on tasks | Notes in the activity log cover it. Conversation stays in chat |
| Deliverable versioning | A new file is a new deliverable. "Supersedes" linking is P2 |
| Email/push notifications, due-date reminders | Due dates are shown, and overdue ones are highlighted. Nothing fires on them |
| Sidebar bot grouping ("Sales team") | Decided separately in D-131. Projects group work, groups group bots |

---

## 3. Concepts and rules

```
Project (optional) ─┬─ Goal ─┬─ Task ── Subtask (one level)
                    │        ├─ Recurring task ── its occurrences
                    │        └─ Routine (existing, gains goalId)
                    └─ Task (no goal)
Goal with no project ─ same children as above
Inbox ─ Task with neither

Deliverable ──► points at an Attachment (FILE), a URL (LINK) or a Message (MESSAGE)
            ──► filed under at most one Task, Goal and Project
```

### 3.1 Project

A grouping of tasks, so the user can run several streams of work at once and look at one or
all of them. **Grouping is optional at every level.** A task can sit in a project, under a goal,
both, or neither. A goal can sit in a project or stand alone, and a goal already groups its own
tasks. A project is for when the user wants a bigger bucket: *Acme SaaS* for work, *Health* for
several personal goals. It holds goals and tasks. It is **not** a folder on the computer and **not** a
memory scope (§9.3). The board defaults to *All projects*, and one click narrows it. Archiving
hides a project and its open tasks. `DELETE` is refused while the project still holds anything.

### 3.2 Task

| Status | Meaning |
|---|---|
| `TODO` | Not started |
| `IN_PROGRESS` | Being worked on |
| `BLOCKED` | Cannot continue. An optional reason is shown on the card |
| `IN_REVIEW` | Finished by whoever did it, waiting for someone to look |
| `DONE` | Finished |
| `CANCELLED` | Won't be done. Hidden from the board, still searchable |

**Anyone can set any status:** the user on the board, or any of the user's bots through
`task_update`. The statuses mean what the user and their prompts make them mean. The app only
records who set each one, and when (§9.1).

Rules that are about data integrity, not workflow:

- **One assignee.** Work split across bots is expressed as subtasks.
- **A parent's status is its own.** Subtask progress is shown (`3/5`), never applied.
- **A subtask shares its parent's project and goal.**
- **Goal and project agree:** a task on a goal that belongs to a project is in that project.
  The service enforces this in one `$transaction`, following `bots.service.ts`. Every referenced
  project, goal, parent, assignee and series must belong to the same user; a foreign ID answers
  404, even when the new row itself carries the caller's `userId`.
- **Deleting a bot** deletes what it produced (§9.4). Tasks assigned to it stay, unassigned,
  with an event naming it.

### 3.3 The Start button

`POST /tasks/:id/start` is a convenience for the user, not a workflow step. A bot never needs it;
a task is only data until someone acts on it.

1. The client sends one `Idempotency-Key` (a UUID) per Start action and reuses it on retries.
   A key already recorded for this task returns its existing `messageId`, even if the task has
   since reached `DONE`; using it for another task is refused (`409 START_KEY_REUSED`). A new
   key refuses an unassigned task (`409 TASK_UNASSIGNED`) or one not in `TODO`
   (`409 TASK_NOT_STARTABLE`). To deliberately run a task again, the user moves it back to
   `TODO` and presses Start with a new key.
2. One owner-scoped transaction conditionally claims the `TODO` task, creates its **USER**
   message with `taskId`, sets `IN_PROGRESS`, and writes the `STARTED` event with the unique
   request key and message link. Concurrent Start requests cannot create two briefs. After
   commit, the existing turn-start path dispatches that message; a pending, unstarted Start
   message is recoverable after a dispatch failure or orchestrator restart, keyed by its
   `messageId`. The request and recovery paths share a reclaimable durable dispatch claim for
   that ID;
   recovery checks `AgentTurn.triggerMessageId` and leaves an active or settled turn alone.
   Retrying never creates another message or turn. The brief is:

   ```
   Task: API auth
   Project: Acme SaaS · Goal: Ship the MVP · Due: 2026-10-03

   <the brief>

   Task id: <id>. When you finish, use task_update to move it to Review, or to Done if there is
   nothing for the user to check, with a one-line note. If you cannot finish, move it to Blocked
   and say what you need.
   ```

   The closing paragraph is D-143's: it tells the bot which task this is and asks it to report
   back. The chat card does not show it.
3. Returns `202 {messageId}` for the new or existing Start. A failure before commit changes
   nothing; a failure after commit leaves one recoverable pending message, not a task that claims
   to have started without work owed.

**Assigning is not starting.** The board offers **Assign** and **Assign & start** separately,
and dragging a card to *In progress* only changes its status. Nothing starts a turn except the
user pressing Start, or a message someone sends.

**The brief is a message, not an instruction.** `agent-instructions.ts` does not change. Per-task
text never enters `instructions`, because D-094's cached prefix must stay byte-identical across
turns.

### 3.4 Goal

An outcome with a target date, for example "Ship the MVP" or "Lose 8 kg by March". It has a
title, an outcome text, an optional `targetOn` date, an **optional** project, and a status of
`ACTIVE`, `ACHIEVED` or `ABANDONED`.

- **Progress** = done ÷ (all − cancelled) over its **one-off top-level** tasks. It is derived
  and never stored.
- **Recurring tasks show how often they were done** instead of counting toward progress:
  done occurrences ÷ occurrences so far, since the goal started ("Work out 11/12"). A goal with
  only recurring tasks shows only those.
- **Routines** link through a new `Routine.goalId`. The goal shows each routine's schedule and
  last result, which M8 already has.
- **The user closes a goal.** At 100% it shows *Ready to close*. It never closes itself.

### 3.5 Deliverable

Something a bot produced that the user may want to find again.

| Kind | Created by | Points at |
|---|---|---|
| `FILE` | **Automatically**, on every bot `attach_file` | the `Attachment` row. Bytes stay under `ARTIFACT_DIR` |
| `LINK` | `deliver_link` (P1); the user | a URL and a title |
| `MESSAGE` | "Save as deliverable" (P1) | a `Message` row, such as a report written inline |

**Filing** is decided when the deliverable is created. The first rule that matches wins:

1. An explicit, owner-checked `taskId` or `goalId` passed to `attach_file`/`deliver_link`.
   If both are supplied they must agree; a foreign or conflicting ID is refused, not filed
   elsewhere.
2. The turn's trigger message `taskId`: either the brief the Start button posted or a
   task-linked bot-to-bot message. `send_message` accepts an optional `taskId`; when omitted it
   inherits the current trigger's task, when `null` it deliberately clears that context. The
   recipient's message stores the resolved `taskId`, after owner checking. A later unrelated
   message never inherits a bot's last task merely because it is in the same conversation.
3. The trigger message `routineId` → that routine's `goalId`.
4. Otherwise none. The deliverable appears under **Unfiled**, and the user or a bot can file it.

`projectId` is denormalised from the task or goal so filtering and search use one indexed column.
Filing under a task derives its goal and project from that task; filing under a goal derives its
project from the goal. Refiling or moving a task/goal updates those derived IDs together. Moving
a goal to another project also moves its child tasks and series in the same transaction; the
filters cannot keep a stale project. An attachment in a later turn without task or routine
provenance remains Unfiled unless the caller supplies an explicit ID.
`sourcePath` records the workspace path the file came from, so a bot asked to check it can open
the real file with `fs_read`. User uploads are inputs, not deliverables.

### 3.6 Recurring tasks

A recurring task is a **series**: a title, brief, assignee, project and goal, plus a schedule.
Each time the schedule comes round, the series creates an ordinary task, an **occurrence**, in
*To do*. Occurrences are real tasks. They get ticked off, noted, assigned and searched like any
other, which is what keeps a history ("did I work out last Wednesday?").

- **Same schedule as routines.** `cron`, `timezone` and `endsOn`, including repeats more often
  than daily, edited with the routine form's repeat choices (D-128/D-129). Scheduling reuses
  the routine machinery: one BullMQ job scheduler per series keyed by its id, reconciled at
  boot, verified across DST and restarts, with a long outage coalesced into one occurrence
  rather than replayed (D-119, D-122). A firing is identified by its scheduled **instant**,
  not its calendar date; retries of that firing make no duplicate, while two firings on the
  same day make two tasks.
- **An occurrence starts nothing.** Not even when it is assigned to a bot. A bot that should
  *do* something on a schedule is a routine. A recurring task is a to-do that comes back. The
  two can share a goal, and a routine can read the occurrences with `task_list`.
- **Missed occurrences stay as they are.** Nothing marks them missed or cancels them. The next
  one is created regardless.
- **The board shows one card per series:** its newest occurrence, with a small history chip
  ("4 of last 5") and an overdue-open count. Older unfinished occurrences remain reachable
  from the card's details and the List view; they are never silently replaced or hidden from
  task queries by the newer occurrence.
- **Editing the series changes future occurrences only.** Stopping it (or reaching `endsOn`)
  keeps every occurrence already created.

---

## 4. Data model (proposed §3 additions)

Field names become contractual when ratified. Every table carries `userId` for R7 scoping.

```prisma
model Project {
  id          String        @id @default(cuid())
  userId      String
  user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  name        String
  description String?       @db.Text
  color       String        // hex, same vocabulary as Bot.avatarColor
  status      ProjectStatus @default(ACTIVE)
  sortOrder   Int           @default(0)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
  goals       Goal[]
  tasks       Task[]
  series      TaskSeries[]
  @@index([userId, status])
}

enum ProjectStatus { ACTIVE ARCHIVED }

model Goal {
  id          String     @id @default(cuid())
  userId      String
  user        User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  projectId   String?
  project     Project?   @relation(fields: [projectId], references: [id], onDelete: Restrict)
  title       String
  outcome     String?    @db.Text
  targetOn    String?    @db.VarChar(10)   // calendar date, same shape as Routine.endsOn
  status      GoalStatus @default(ACTIVE)
  closedAt    DateTime?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
  tasks       Task[]
  series      TaskSeries[]
  routines    Routine[]
  @@index([userId, status])
}

enum GoalStatus { ACTIVE ACHIEVED ABANDONED }

model Task {
  id             String     @id @default(cuid())
  userId         String
  user           User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  projectId      String?    // null = Inbox
  project        Project?   @relation(fields: [projectId], references: [id], onDelete: Restrict)
  goalId         String?
  goal           Goal?      @relation(fields: [goalId], references: [id], onDelete: SetNull)
  parentId       String?    // one level: a parent's parentId is always null (service-enforced)
  parent         Task?      @relation("Subtasks", fields: [parentId], references: [id], onDelete: Cascade)
  subtasks       Task[]     @relation("Subtasks")
  title          String
  brief          String?    @db.Text
  status         TaskStatus @default(TODO)
  blockedReason  String?    @db.Text
  assigneeBotId  String?
  assigneeBot    Bot?       @relation("TaskAssignee", fields: [assigneeBotId], references: [id], onDelete: SetNull)
  origin         TaskOrigin @default(OPERATOR)   // who created it; mirrors Routine.origin (D-125)
  seriesId       String?    // set on an occurrence; SetNull if the series is deleted
  series         TaskSeries? @relation(fields: [seriesId], references: [id], onDelete: SetNull)
  occursAt       DateTime?  // scheduled instant: retry identity, including hourly/minute repeats
  occursOn       String?    @db.VarChar(10) // local date for display and date-range queries
  createdByBotId String?
  dueOn          String?    @db.VarChar(10)
  rank           String     // lexicographic order within a column; a drag is one row write
  startedAt      DateTime?
  completedAt    DateTime?
  createdAt      DateTime   @default(now())
  updatedAt      DateTime   @updatedAt
  events         TaskEvent[]
  deliverables   Deliverable[]
  messages       Message[]
  @@index([userId, status])
  @@index([assigneeBotId, status])
  @@index([parentId])
  @@index([goalId])
  @@unique([seriesId, occursAt])   // one occurrence per scheduled firing, however often retried
  @@index([userId, goalId, occursOn])
}

enum TaskStatus { TODO IN_PROGRESS BLOCKED IN_REVIEW DONE CANCELLED }

/// §3.6 — a task that comes back. Each firing creates one Task with seriesId set.
model TaskSeries {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  title         String
  brief         String?  @db.Text
  assigneeBotId String?  // SetNull
  assigneeBot   Bot?     @relation("SeriesAssignee", fields: [assigneeBotId], references: [id], onDelete: SetNull)
  projectId     String?
  project       Project? @relation(fields: [projectId], references: [id], onDelete: Restrict)
  goalId        String?  // SetNull
  goal          Goal?    @relation(fields: [goalId], references: [id], onDelete: SetNull)
  cron          String   // same CronSchema/TimezoneSchema as Routine
  timezone      String
  endsOn        String?  @db.VarChar(10)
  enabled       Boolean  @default(true)
  lastFiredAt   DateTime?
  origin        TaskOrigin @default(OPERATOR)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  occurrences   Task[]
  @@index([userId, enabled])
  @@index([goalId])
}
enum TaskOrigin { OPERATOR BOT }

/// "Who did what, when." Append-only.
model TaskEvent {
  id          String        @id @default(cuid())
  taskId      String
  task        Task          @relation(fields: [taskId], references: [id], onDelete: Cascade)
  userId      String
  user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  actor       TaskActor
  actorBotId  String?       // SetNull: history outlives the bot
  actorLabel  String        // name at the time, so a deleted bot still reads "Backend"
  type        TaskEventType
  payload     Json          // e.g. {from, to} for STATUS_CHANGED; validated by a shared schema
  startKey    String?       // STARTED only; identifies retries even after status changes
  messageId   String?       // BOT reply for a tool edit, Start brief for STARTED; null for board edits
  message     Message?      @relation(fields: [messageId], references: [id], onDelete: SetNull)
  createdAt   DateTime      @default(now())
  @@index([taskId, createdAt])
  @@unique([userId, startKey])
}

enum TaskActor { USER BOT }
enum TaskEventType { CREATED EDITED ASSIGNED UNASSIGNED STARTED STATUS_CHANGED NOTE DELIVERABLE_LINKED }

model Deliverable {
  id           String          @id @default(cuid())
  userId       String
  user         User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind         DeliverableKind
  title        String
  summary      String?         @db.Text
  botId        String?         // producer. Cascade: a deleted bot takes its deliverables (§9.4)
  bot          Bot?            @relation(fields: [botId], references: [id], onDelete: Cascade)
  attachmentId String?         @unique   // Cascade: the record goes with its file
  attachment   Attachment?     @relation(fields: [attachmentId], references: [id], onDelete: Cascade)
  messageId    String?         // Cascade, for the same reason
  message      Message?        @relation(fields: [messageId], references: [id], onDelete: Cascade)
  url          String?
  sourcePath   String?         // where in the workspace the file was attached from
  taskId       String?
  task         Task?           @relation(fields: [taskId], references: [id], onDelete: SetNull)
  goalId       String?
  goal         Goal?           @relation(fields: [goalId], references: [id], onDelete: SetNull)
  projectId    String?         // denormalised from task/goal (§3.5)
  project      Project?        @relation(fields: [projectId], references: [id], onDelete: SetNull)
  searchText   String?         @db.Text   // P1: bounded extract of a text-like file
  createdAt    DateTime        @default(now())
  @@index([userId, createdAt])
  @@index([taskId])
  @@index([goalId])
  @@index([projectId])
}

enum DeliverableKind { FILE LINK MESSAGE }
```

**Changes to existing models:**

| Model | Change | Why |
|---|---|---|
| `Message` | `taskId String?` (SetNull) | The Start button's brief, rendered as a task card and used for filing rule 2 |
| `Message` | `routineId String?` (SetNull) | The provenance the routine runner's own comment says is missing. Filing rule 3 |
| `Routine` | `goalId String?` (SetNull) | A routine working toward a goal |
| `Bot`, `User`, `Message`, `Attachment` | Inverse relations for the models above | Prisma's relations must validate as a complete schema, not just as the field sketch shown here |

The migration must add the listed foreign keys and validate the complete Prisma schema. A
`userId` column on a row does not prove that its referenced project, goal, task, bot, message or
attachment belongs to that user; services validate those references before linking them.

**Hand-written FTS indexes** on `Task(title, brief)`, `Goal(title, outcome)` and
`Deliverable(title, summary, searchText)` follow the D-073 pattern, asserted from `pg_indexes`.
`Message_content_fts_idx` already exists.

---

## 5. Interface contracts (proposed §4 additions)

### 5.1 REST (under `/api/v1`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects?status=` | list, with open-task and goal counts |
| `POST` | `/projects` | `{name, description?, color}` |
| `PATCH` | `/projects/:id` | edit; `{status: 'ARCHIVED'}` archives |
| `DELETE` | `/projects/:id` | `409 PROJECT_NOT_EMPTY` unless it holds nothing |
| `GET` | `/tasks?projectId=&inbox=&goalId=&assigneeBotId=&status=&parentId=&seriesId=&occursFrom=&occursThrough=` | board/list query; top-level only unless `parentId` is given. Date filters use `occursOn` in the series' timezone and include completed and overdue occurrences when requested |
| `POST` | `/tasks` | `{title, brief?, projectId?, goalId?, parentId?, assigneeBotId?, dueOn?, repeat?: {cron, timezone, endsOn?}}`. With `repeat` it creates a series and its first occurrence when due; creation never starts a turn |
| `GET` | `/task-series/:id` | the series with its recent occurrences |
| `PATCH` | `/task-series/:id` | edit future occurrences, change the schedule, `enabled: false` stops it |
| `DELETE` | `/task-series/:id` | stops it; occurrences already created stay |
| `GET` | `/tasks/:id` | task with subtasks, events (newest 100), deliverables, `usage` (P1, D-141) |
| `PATCH` | `/tasks/:id` | fields, status, assignee, `rank` |
| `DELETE` | `/tasks/:id` | cascades subtasks and events; deliverables are unfiled, never deleted |
| `POST` | `/tasks/:id/start` | Requires `Idempotency-Key: <UUID>`; §3.3 → `202 {messageId}`. A retry with the same key returns the same ID and dispatches no duplicate turn |
| `POST` | `/tasks/:id/notes` | `{text}` → a `NOTE` event |
| `GET` | `/goals?status=&projectId=` | with derived progress |
| `POST` | `/goals` | `{title, outcome?, targetOn?, projectId?}` |
| `GET` | `/goals/:id` | tasks, routines, deliverables, progress, `usage` (P1, D-141) |
| `PATCH` | `/goals/:id` | fields, status |
| `DELETE` | `/goals/:id` | unlinks tasks and routines; deletes nothing else |
| `GET` | `/deliverables?projectId=&goalId=&taskId=&botId=&kind=&unfiled=&q=&before=&limit=` | newest first, cursor-paginated; `q` matches title or summary (D-142) |
| `POST` | `/deliverables` | `{kind: 'LINK', url, title}` or `{kind: 'MESSAGE', messageId, title}` (P1) |
| `PATCH` | `/deliverables/:id` | title, summary, re-file under a task, goal or project |
| `DELETE` | `/deliverables/:id` | removes the record; the attachment and message stay in the transcript |
| `GET` | `/search?q=&types=&botId=&projectId=&limit=` | §7.6. Hits grouped by type, each with an excerpt |
| `GET` | `/bots/:id/messages?around=<messageId>&limit=` | **extends** the existing route, for jump-to-message |

`POST`/`PATCH /routines` accept `goalId`. Every direct-by-id route declares
`@OwnedResource('project' | 'goal' | 'task' | 'taskSeries' | 'deliverable', 'id')`, and
`ownership-route-coverage.test.ts` fails the build until each one does.

`send_message` gains optional `taskId?: string | null` in its tool schema, not a new route.
Omitting it inherits the trigger message's task, passing `null` clears task context, and passing
an ID requires an owned task. The delivered `Message.taskId` is set before the receiving turn
starts. Bot `task_update` events link `messageId` to the caller's reply; board edits have no
message link. **Assign & start** calls `POST /tasks` (or `PATCH /tasks/:id`) and then the one
`POST /tasks/:id/start` path with a key generated once for that action; there is no `start`
flag on task creation that bypasses its idempotency rule.

### 5.2 WebSocket (server → client)

| `type` | Payload | When |
|---|---|---|
| `task.changed` | `{taskId, deleted?: true}` | any create, update, delete or move, by the user or a bot |
| `project.changed` | `{projectId, deleted?: true}` | project create, edit, archive or delete |
| `goal.changed` | `{goalId, deleted?: true}` | goal create, edit, close or delete |
| `deliverable.changed` | `{deliverableId, deleted?: true}` | deliverable create, refile, edit or delete |

These frames go to the **client only**. No bot is ever sent anything because a task changed
(§0.1). All four frames enter through `chatReducer`'s exhaustive switch into a separate `work`
slice, so they never touch `messagesByBot`. The IDs invalidate the affected board, details,
goal/project counts and Deliverables queries; the server remains the source of truth for
derived counts. A subtask change invalidates its parent card, and a filing change invalidates
the relevant task, goal and project views. On reconnect, those views refetch rather than
assuming every notification was received.

---

## 6. Bot tools (proposed M5 registry additions)

Plain reads and writes over the user's rows, with no roles attached. Any of the user's bots may
call any of them on any of the user's tasks (§9.8). All of them are classified `contained`
(D-092), so none asks for approval (§9.5).

| Tool | Behaviour | Approval |
|---|---|---|
| `task_list({assignee?, status?, projectId?, goalId?, seriesId?, occursFrom?, occursThrough?})` | The user's tasks. With no filter, the calling bot's open ones; `assignee: 'any', status: 'any'` includes the user's completed and missed occurrences. Date bounds are calendar dates in each series' timezone | none |
| `task_read({taskId})` | Brief, subtasks, recent events, deliverables with `sourcePath` | none |
| `task_create({title, brief?, projectId?, goalId?, parentId?, assignee?, after?})` | Creates in *To do*, placed after `after` when given. With `repeat: {cron, timezone, endsOn?}` it creates a recurring task (§3.6). **Starts nothing** | none |
| `task_update({taskId, status?, note?, blockedReason?, assignee?, title?, brief?, projectId?, goalId?})` | Any field, any status. A `note` becomes a `NOTE` event. On an occurrence, `repeat` edits its series and `repeat: null` stops it | none |
| `project_create({name, description?, goal?})` | Creates a project, and optionally its goal | none |
| `attach_file(path, note, taskId?, goalId?)` | **Extended:** optional filing; always records a `FILE` deliverable with `sourcePath` | unchanged |
| `send_message(..., taskId?)` | **Extended:** propagate or explicitly set/clear task context on the delivered message (§3.5). The existing hop and budget limits still apply | unchanged |
| `deliver_link({url, title, summary?, taskId?, goalId?})` (P1) | Records a `LINK` deliverable | none |

There is no tool that starts another bot's work. **Telling a bot what to do is `send_message`**,
which already exists, runs without approval, and keeps D-047's operator-set ceilings (§9.5).

### 6.1 What the tool descriptions say

The descriptions follow `docs/VOICE.md`, name no vendor, and stay short:

- These are the user's tasks. Use them when the user asks, when the work you were given came
  from a task, or when another bot asks you to on the user's behalf.
- Do not create tasks to organise your own work, and do not turn an ordinary request into a
  task.
- When a request is big enough that splitting it would help, you may **suggest** tasks in your
  reply. Create them only after the user agrees.
- When you change a task's status, a short `note` saying what happened helps whoever reads the
  task later.

That is guidance, not enforcement: nothing is refused for a missing note. It is tested as
behaviour with CC-18's eval harness (§10).

---

## 7. UI: where each piece goes

### 7.1 The shell stays three-pane; the sidebar gains a Work section

```
┌──────────────────────┬─────────────────────────────────────┬────────────────────┐
│ ○ ○ ○            [+] │  Tasks · Acme SaaS          [Board▾]│ ✕  Task details    │
│ ┌──────────────────┐ │  ┌ Filter: Goal ▾  Bot ▾  Due ▾ ┐   │ API auth           │
│ │⌕ Search       ⌘K │ │                                     │ ● Done ▾           │
│ └──────────────────┘ │  TO DO     IN PROGRESS  REVIEW  DONE│ Assignee (B)Backend│
│  ☐ Tasks          2  │ ┌───────┐ ┌─────────┐ ┌──────┐     │ Goal  Ship the MVP │
│  ◎ Goals             │ │Billing│ │Login    │ │API   │     │ Due   Oct 3        │
│  ▤ Deliverables      │ │page   │ │page     │ │auth  │     │ ─ Brief ─────────  │
│                      │ │(F)    │ │(F) 1/3  │ │(B)📎2│     │ …                  │
│ PROJECTS          +  │ └───────┘ └─────────┘ └──────┘     │ ─ Deliverables ──  │
│  ● Acme SaaS         │                                     │ 📄 auth-notes.md   │
│  ● Outbound Q3       │                                     │ ─ Activity ──────  │
│  ○ Inbox             │                                     │ Backend → Done 2h  │
│                      │                                     │   "JWT + refresh…" │
│ BOTS                 │                                     │ PM assigned 1d     │
│  (P) PM              │                                     │ PM created 1d      │
│  (F) Frontend        │                                     │                    │
│  (B) Backend         │                                     │ [Open conversation]│
│ ⚙ Plugins   NE       │                                     │                    │
└──────────────────────┴─────────────────────────────────────┴────────────────────┘
```

- **Under search: three nav rows.** Tasks, Goals and Deliverables. Selecting one swaps the
  **centre pane** from a transcript to that view. *Tasks* shows a badge counting *Review* and
  *Blocked* cards. With no tasks the rows are quiet, and each view opens on a short empty
  state saying what it is for.
- **`PROJECTS` section**, collapsible, in small caps (the ref-03 label style UI-SPEC adopts).
  Clicking a project opens Tasks filtered to it. `+` creates one inline. *Inbox* is last.
- **`BOTS` section** is today's list, unchanged. Selecting a bot returns the centre pane to its
  transcript.
- **The right rail shows details of whatever is selected**, as it already does for
  `BotProfilePane`.

### 7.2 Tasks view (centre pane)

- **Board** (default): To do · In progress · Blocked · Review · Done. *Done* shows the last
  14 days, with "Show all" below. Cancelled tasks are hidden.
- **Group by:** Status (default), **Bot** (one swimlane per bot: "who is doing what"), or
  Project.
- **List** toggle: a dense table with the same filters.
- **Card:** title, assignee avatar, project dot, subtask progress `1/3`, deliverable count
  `📎2`, due date (red when overdue), and a live `StatusDot` while the assignee is working.
- **Recurring:** one card per series, showing its newest occurrence, a `↻` mark, a history
  chip ("4 of last 5") and the number of older open occurrences. The card opens a history
  where those older tasks can still be completed; List can show them individually.
- **Quick add:** `+ Add task` at the top of *To do*, with a **Repeat** option.
- **Drag** between columns changes the status and nothing else.

### 7.3 Task details (right rail)

Title, status, assignee (with **Assign & start**), project, goal, due date, brief (markdown,
editable), subtasks (inline add, each with its own assignee), deliverables (preview and
download), and activity: who, what and when, each row with its note and a jump to the message
it came from. The footer holds **Start** and **Open conversation**, which opens the assignee's
transcript at its most recent task-linked message (Start brief or delegated instruction). If
there is no linked message yet, it opens the assignee's transcript normally.

### 7.4 In a bot's chat

- **Rail section "Tasks"** between the screen card and Routines, **shown only when this bot has
  open tasks**. Up to five, each with its status, and "See all".
- **Transcript:** a Start-button brief renders as a **task card part** instead of a plain USER
  bubble. A deliverable chip gains a small "→ Task name" link when it is filed.
- **Message menu (P1):** *Create task from this message*, *Save as deliverable*.
- **Routines panel:** a routine shows its goal chip, and the form gains an optional **Goal**.

### 7.5 Goals and Deliverables views (centre pane)

**Goals:** one card per active goal with its target date, a progress bar (`12/20 tasks`), each
recurring task's done rate (`Work out 11/12`), the linked routines with their last result, and *Ready to close* at 100%. Details in the rail show
the outcome, tasks by status, routines, deliverables, and *Mark achieved* / *Abandon*.

**Deliverables:** newest first, with type icon, title, producing bot, task / goal / project
chips and date. Filters: project, goal, bot, kind, date, *Unfiled*. Selecting one previews it in
the rail: markdown and text rendered, images and PDFs inline, CSV as a table. Previews load
through `ApiClient.download()` (D-025: fetched, never linked). Actions: *Download*, *File under…*,
*Open in conversation*. Refiling, edits and deletion update the open view through
`deliverable.changed`, just as creation does.

### 7.6 Search: one box, everything

The sidebar search box gains `⌘K`. Typing filters bots **inline, as today**. Below the bot
matches, **"Search everything for 'prd' ↵"** opens a results palette over the centre pane:

```
┌──────────────────────────────────────────────────────────┐
│ ⌕ prd                               [All|Tasks|Files|Chat]│
│ DELIVERABLES                                              │
│  📄 **PRD**.md · PM · Sep 23 · Acme SaaS                   │
│ TASKS                                                     │
│  ☐ Split the **PRD** into tasks · PM · Done               │
│ CONVERSATIONS                                             │
│  (P) PM · Sep 23 — "…the **PRD** covers auth, billing…"   │
│ GOALS                                                     │
│  ◎ Ship the MVP                                           │
└──────────────────────────────────────────────────────────┘
```

Hits are grouped by type and ranked within each group, with `ts_headline` excerpts of at most
two fragments (D-077). Selecting a hit jumps there. A message opens its bot's transcript around
it, through `?around=`. The user's search covers **every** bot's transcript. D-077's
own-transcript boundary applies to bots, not to the person who owns all of them.

---

## 8. Cross-cutting requirements

- **R7 / D-010 / D-026:** every query scoped by `principal.userId`; every by-id route marked;
  the Prisma allowlist grows only with scoped call sites. A bot's task tools are scoped to its
  owner's rows the same way.
- **R1:** the renderer holds no filing, progress or search logic. Its only derivation is
  progress refreshed from `task.changed`, using the same function exported from
  `packages/shared`.
- **Contracts:** every new schema lives in `packages/shared` with a valid/invalid fixture pair.
  `API_ROUTES` gains the paths, and components call `api/<resource>.ts`, never `fetch`.
- **A notification path must not fail a turn.** Emitting a `*.changed` frame follows
  `TurnEventBus`'s rule: safeParse, log, drop; a client refetches after reconnect. Filing a
  deliverable is durable state, not a notification. `attach_file` first reserves and writes
  the file as today, then **claims the Attachment for the reply and creates its FILE
  Deliverable in one database transaction**, including `sourcePath` from the tool input. If
  either database write fails, neither claim nor deliverable commits: the tool reports a
  failure, the unclaimed reservation is cleaned up (the existing reaper is the fallback), and
  the sandbox source file remains available for a retry. A successful bot attachment can
  therefore never be absent from the Deliverables index.

| Metric | Budget |
|---|---|
| Board load, 500 open tasks | ≤ 300 ms p95 server time |
| A bot's `task_update` to the card moving | ≤ 1 s |
| `/search`, 100k messages + 5k deliverables | ≤ 400 ms p95 |
| Text added to `instructions` | none (§3.3) |
| All new tool definitions combined | ≤ 500 estimated tokens (re-sent every step, for every bot, whether or not tasks are used) |

---

## 9. Decisions

The owner decided these on 2026-09-23. They become D-1xx entries as written.

### 9.1 Anyone can mark a task Done

The user or any bot. Bots run long tasks, and the user will not watch each one to close it.
The app records who set each status and when. It does not require a note, a review step or an
approval. Whether some bot checks finished work is the user's instruction to that bot (§0.2,
step 7).

### 9.2 Keep the bots' `BOARD.md` notepad, and word the two apart

`/home/bot/shared/BOARD.md` and `board_read/add/update` (D-068) are the bots' own working
notes, which the user never sees in the app. Tasks are the user's list. Both stay. The board
tools describe it as "your team's working notes, not the user's task list", and the task tools
say "the user's tasks", so "check the board" and "check your tasks" cannot be mixed up. Two tool
descriptions change, and nothing else.

### 9.3 A project groups tasks, and several can be active at once

It is only a grouping, and an optional one: goals and tasks can live without one (§3.1). It is not a folder on the computer and not the memory project scope D-073
reserved for multiple checkouts. Keep the two named distinctly in code.

### 9.4 Deleting a bot deletes everything it produced

A bot's conversation, attachments and **deliverables** go with it: `Deliverable` cascades from
`Bot`, `Attachment` and `Message`, and D-019/D-020 are unchanged. The delete confirmation adds
the count ("Backend's 14 deliverables will be deleted"). Tasks assigned to the bot are the
user's plan and stay, unassigned. The activity log keeps the bot's name. This is permanent data
loss by the owner's explicit choice, so the confirmation offers the already-shipped **Hide from
sidebar** action for someone who wants the bot out of view but needs its conversation and files
later. Hiding does not stop the bot or change its permissions; it only preserves that history.

### 9.5 No approval for bot-to-bot messages or task edits

A bot that messages another bot has a reason to. Asking the user each time turns them into a
babysitter for acts that destroy nothing. **This is already how the code works.** D-092 classifies
`send_message` as `contained` (`send-message.tool.ts`), and contained tools run without asking.
The note in `CLAUDE.md` that it "falls through to D-064's default `ask`" predates D-092 and is
out of date. That line should be corrected when this PRD is ratified.

The task and project tools are `contained` too. Approval stays where D-092 put it: destroying
something, spending money, or acting as the user outside the sandbox (`shell` with destructive
arguments, `use_identity`, write-classified plugin tools). A user can still add an `ask` rule
for any tool on any bot. D-047's chain accounting stays, and its ceilings stay the operator's.

### 9.6 M10, worked before M9

M9 is the conditional paid-launch gate (D-033) and does not block this. The order goes in
`MILESTONE_ORDER` (D-089/D-090), without renumbering.

### 9.7 Goals don't need a project, and recurring tasks exist

A personal goal like losing weight has no project. It holds recurring tasks and routines
directly (§0.3). Recurring tasks are in v1 as series that create ordinary occurrences on the
routine schedule machinery, and never start work (§3.6).

### 9.8 The app stays unopinionated

There are no roles (no lead or manager bot), no automatic notifications, no verification
workflow, and no rules about which bot may change which task. The user can tell any bot to tell
any other bot anything. Every team shape is something the user prompts, not something the
product encodes. The product's job is to keep an accurate, searchable record of what the user
and their bots did, and to show it well.

---

## 10. Milestone M10 — Work

### Phases

| Phase | Contents | Priority |
|---|---|---|
| **W1 — Tasks** | Project, Task, subtasks, TaskEvent; routes; board, list, rail details; atomic, recoverable Start; `Message.taskId`; task card part; bot task and project tools; `send_message` task context; `task.changed` and `project.changed`; board-tool wording (§9.2); behaviour evals | P0 |
| **W2 — Deliverables** | Deliverable model; atomic attachment claim and FILE deliverable record with filing and `sourcePath`; `Message.routineId`; Deliverables view with preview; the count and Hide alternative in bot-delete confirmation; `deliverable.changed` | P0 |
| **W3 — Goals and recurring tasks** | Goal model; `Routine.goalId`; TaskSeries with scheduled-instant identity on the routine machinery; Goals view and details; progress and done rates; series card, overdue count and history; goal and repeat fields on task and routine forms; `goal.changed` | P0 |
| **W4 — Search** | FTS indexes; `/search`; `?around=`; the ⌘K palette | P0 |
| **W5 — Extras** | `deliver_link`; save-as-deliverable; create-task-from-message; `schedule_routine` goal; text extraction; cost per task/goal | P1 |

`M10-BE-09` and `M10-FE-08` carry `gateOptional: true` in `tasks.json`. The task-graph
validator excludes only explicitly marked optional tasks from `M10-RV-01` coverage; every P0
task remains a dependency of the gate. W1 and W2 can be reviewed as an end-to-end slice before
W3 and W4, while the M10 gate still requires all four P0 phases.

### Acceptance criteria (P0)

- **The reference scenario runs end to end** (§0.2), with stubbed models in CI and once with a
  real model before the gate. The board, activity log and Deliverables view reflect every step
  without a refresh. Bot-originated activity names the bot and links its reply; `STARTED` links
  the brief; board edits name the user and have no message link.
- The PM's `send_message({taskId})` gives Backend's trigger message that task ID. Backend's
  attachment is filed under the same task without another ID argument; a later unrelated
  turn is Unfiled. Passing `taskId: null` clears inherited context.
- **The app acts on nothing by itself.** Across the scenario, every task row was created by
  the user, a bot's tool call or the recurrence the user scheduled. No turn was started by an
  ordinary task create, edit or status change. **No message was sent to any bot** because one
  of those changes occurred. The explicit Start action, `send_message` and a routine are the
  only message-producing actions in the scenario; this is asserted by counting messages, not
  by reading the code.
- A user who never creates a task sees no change: no badge, no rail section, and a bot's
  `instructions` are byte-identical to today's.
- Asking a bot "split this into tasks for Frontend and Backend" creates them in *To do*, assigned
  as asked. **None starts.**
- Any bot can set any status on any of the user's tasks, and the activity log records which bot
  did it.
- The Start button posts one brief to the assignee and nothing else. A double click, request
  retry with the same key (including after completion), or restart between commit and dispatch
  creates no second message or turn and does not lose the pending first turn. Dragging a card
  changes only its status.
- A file a bot attaches after a Start-button brief is filed under that task, its goal and its
  project without the bot passing `taskId`. A file attached with no task provenance appears under
  *Unfiled*.
- A routine linked to a goal files its runs' attachments under that goal.
- **The weight-loss scenario (§0.3) works:** a goal with no project, two recurring tasks and a
  routine. Occurrences appear on their days in the series' timezone, and the goal shows each
  done rate. The Sunday routine's bot lists the week's occurrences with `task_list`.
- A recurring task assigned to a bot creates occurrences and **starts no turn**.
- Across a DST change and an orchestrator restart, a series creates exactly one occurrence per
  scheduled firing: no duplicate, no gap. Two hourly firings on the same date create distinct
  occurrences. After a long outage it creates one occurrence, not a backlog. Older unfinished
  occurrences remain visible from the series card and List.
- Bots message each other and edit tasks with no approval prompt under the shipped rules.
- Deleting a bot deletes its deliverables along with its conversation and attachments. Its tasks
  stay, unassigned, with an event naming it. The confirmation states the deliverable count.
- Goal progress equals done ÷ (all − cancelled) over top-level tasks, and updates as cards move.
- A phrase in one transcript, one task brief and one deliverable title returns all three,
  grouped. Selecting the message opens that transcript with it in view.
- Creating, editing, refiling and deleting work records refreshes every open affected view;
  subtask progress, goal progress and project/deliverable counts are correct after reconnect.
- No task text appears in `instructions`, and the cached prefix is byte-identical across two
  turns with different tasks (the D-094 test extended).

### Required tests

- Shared: fixture pairs for every new schema; all four new frames round-trip.
- Behaviour eval (CC-18 harness): an ordinary request produces **no** `task_create`; a large
  multi-part request produces a suggestion and **no** `task_create` before the user agrees; an
  explicit "create tasks for this" produces them.
- Unit: filing resolver, covering all four rules in order.
- Unit: done-rate derivation for a series, over a goal's lifetime, with missed and cancelled
  occurrences.
- Integration: series scheduling. Fake timers across a DST boundary; a restart between firings;
  `@@unique([seriesId, occursAt])` absorbs a retried job while two firings on one local date
  persist; disabling removes the job scheduler from Redis (the M8 tests' shape).
- Unit: the shipped rules resolve `send_message` and every task tool to no approval (D-092).
- Unit: progress derivation covering cancelled tasks, subtasks excluded, and empty goals.
- Unit: `chatReducer` handles all four frames without touching `messagesByBot` (referential
  check), invalidates parent/goal/project counts, and refetches on reconnect.
- Integration: Start → brief with `taskId` → turn → `task_update` → `task.changed` on a WS
  client → DB state.
- Integration: concurrent Starts, repeated Starts, and crash/retry between commit and turn
  dispatch each yield one brief, one event and at most one turn for the claimed Start.
- Integration: `send_message` carries an owned task ID across one and two hops; foreign IDs
  fail closed, explicit `null` clears it, and the recipient's attachment files correctly.
- Integration: a failed deliverable insert rolls back the attachment claim; `attach_file`
  reports failure, no attachment chip or deliverable is announced, and the sandbox source file
  can be retried. A successful retry creates one claimed attachment and one deliverable.
- Integration: a bot's `task_update` on another bot's task succeeds and is attributed to the
  caller.
- Integration: across a scripted run, ordinary task creates, edits and status changes create
  no message rows (the absence asserted beside a presence: the same run does create task rows
  and events). Explicit Start and `send_message` are measured separately.
- Integration: bot deletion removes its deliverables and their files, and unassigns its tasks
  with the event.
- Integration: ownership. A foreign user's ids return 404 on every route, a bot's task tools
  cannot see a foreign user's rows, and search returns no foreign hits **when foreign rows
  exist**.
- Integration: FTS indexes present in `pg_indexes`, and the search plan uses them.
- Integration: creating, editing, refiling and deleting each work record emits the expected
  invalidation frame; a reconnect refetch restores all views and derived counts.
- Route coverage and the Prisma allowlist updated in the same change.
- E2E: create a task, assign and start it, see the card move when a stubbed bot updates it, and
  open the deliverable preview.

---

## 11. Open questions for the owner

1. ~~Is Done's 14-day window right?~~ Settled by D-140: 14 days, with *Show all*.

Settled on 2026-09-23: unassigned tasks are the user's own (§0.3), and a goal does not need a
project (§9.7).
