# Behaviour eval (CC-18)

Scores whether a bot still **behaves**, not just whether its loop runs. It checks
that a bot:

- keeps a correct answer under pressure, but updates on a real correction
- never claims to be a person
- reads before it answers, and doesn't call tools for small talk
- treats tasks as the user's: makes none of an ordinary request, suggests a split
  of big work before creating anything, and creates the task when asked

Run it after a model swap or a prompt edit. Those are the changes this catches.

| File | What it is |
|---|---|
| `cases.ts` | The cases: a scripted conversation, its checks, and a `stub` script of the expected behaviour |
| `harness.ts` | Subjects, checks, the model-graded judge, and the report |
| `cli.ts` | The live runner (below) |
| `../behavior-eval.test.ts` | The CI run |

## What CI proves, and what it doesn't

`behavior-eval.test.ts` runs every case against a **deterministic stub model**
that plays the case's own script, so it needs no key and scores the same twice.
That proves the **harness**:

- every case passes on the behaviour it describes
- a bot that caves on the third push, claims to be a person, answers without
  reading, or refuses a real correction is caught, and the failing check is named
- a model error, a turn that never settles, or a judge that answers nonsense is
  a **harness failure** (exit 2), never a regression and never a pass
- in orchestrator mode, each case's bot is deleted even when the case fails

It does **not** prove any real model behaves. Only a live run does that.

## Live runs

Every live run spends real tokens.

```bash
# Two models side by side: a provider:model swap, scored per model
EVAL_MODELS=anthropic:claude-sonnet-5,openai:gpt-5.1 \
EVAL_API_KEY_ANTHROPIC=… EVAL_API_KEY_OPENAI=… \
EVAL_JUDGE=anthropic:claude-opus-5 \
pnpm --filter @crewaid/orchestrator eval:behavior

# A running orchestrator, over HTTP, the way the desktop reaches it
EVAL_ORCHESTRATOR_URL=http://localhost:3000 EVAL_ORCHESTRATOR_TOKEN=<session token> \
pnpm --filter @crewaid/orchestrator eval:behavior
```

The variables are `EVAL_`-prefixed on purpose. The orchestrator stopped reading
process-wide provider keys in V1 (D-083), and this tool mustn't make it look as
if it does again.

- **Without `EVAL_JUDGE`**, rubric checks are listed under **NOT SCORED**. The
  exact-match checks still decide each case.
- **Orchestrator mode** creates one bot per case and deletes it afterwards. The
  product's workspace retention keeps the deleted bot's volume for
  `SANDBOX_WORKSPACE_RETENTION_DAYS`. Cases that bring their own tools or check
  tool calls are skipped there, with the reason: §4.1 has no route that returns
  a turn's steps.

Exit codes: **0** every scored case passed · **1** a regression (the bot
misbehaved) · **2** a harness failure (the run proved nothing). Reports go to
`.artifacts/behavior-eval/report.txt` and `report.json`.

## The Work cases

They hand the model the shipped Work tools, with the same descriptions and
input schemas a bot is sent (built from `workTools` in `src/work/work-tools.ts`),
because PRD-WORK §6.1's guidance lives in those descriptions. Re-run them live
after editing a word of that wording. In orchestrator mode they're skipped,
because they check tool calls.

## Adding a case

Put the check that can be exact in exact-match (`includes`, `excludes`, `called`,
`not-called`, `no-tools`; the tool checks also take `turns`), and the part that
can't in a `judge` rubric. Write the `stub` as the behaviour you want, then add a
test to `behavior-eval.test.ts` that swaps in the behaviour you don't want and
asserts the case fails on the right check. A check nobody has seen fail isn't
evidence.
