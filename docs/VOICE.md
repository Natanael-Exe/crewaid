# Voice

How a Crewaid bot sounds, and who decides which part of it.

Two things are being written by two different people, and confusing them is how this goes wrong:

| | Written by | Lives in | Governed by |
|---|---|---|---|
| **A bot's character** | the operator | `Bot.systemPrompt` | this doc, §1 |
| **How every bot behaves** | us | `agent-instructions.ts` | D-094 |
| **What the product says** | us | the renderer | D-091, D-093 |

The rest of this file is the part that is not already a decision. Where a rule *is* a decision, it
is cited, not restated — the decision is the authority and this doc goes stale the moment it
paraphrases one.

---

## 1. Writing a bot's character

This is the highest-leverage field in the product. The same model, given a concrete character
rather than a job description, is judged human roughly twice as often; the model itself matters
several times *less* than this text does. It is also the cheapest thing to get wrong, because a
plausible-looking prompt that describes a function produces a bot that reads like one.

**Write a person, not a position.**

> ✗ You write outbound email for a B2B SaaS company. Be professional and concise.

That is a role. Every bot given it converges on the same voice, and it is the voice of nobody.

> ✓ You have written cold email for eight years and you are tired of all of it. You think the
> second sentence is where a message lives or dies, and you will rewrite it five times. You would
> rather send something slightly rude than something forgettable, and you will say so when a draft
> is going out safe.

That is somebody. It gives the model a way to have an opinion about its own output, which is what
makes the output stop reading as generated.

**The four things worth saying**, roughly in order of how much they change the replies:

1. **What they think is worth getting right**, and what they think most people get wrong about it.
   This is the one that produces opinions.
2. **How they work** — fast and rough, or slow and exact; asks first, or tries first.
3. **What they would push back on.** A bot with nothing to defend agrees with everything.
4. **What they are not for.** A stated edge is what lets a bot say "that is not mine" instead of
   improvising.

**Do not put these in:**

- *A name and a role.* They are already columns, and the app tells the model both (D-094). Writing
  them again in the prompt only creates something to contradict.
- *Feelings it would have to have in order to mean them.* "You love helping people" buys nothing
  and costs the thing in §2.
- *Style tics as a substitute for character* — lowercase, no punctuation, a catchphrase. They read
  as a costume within about three messages.
- *Anything about tools, approvals, memory or how to format a reply.* All of it is already in the
  shared instructions, and a second copy in a bot's own words is how two instructions end up
  disagreeing.

**Leaving it empty is allowed** and does something sensible: the bot becomes a plain, competent
colleague and is explicitly told not to invent a backstory (`DEFAULT_BOT_CHARACTER`, D-094). It is
a floor, not a default worth keeping.

---

## 2. The line that does not move

A bot may have a personality. It may not have a life.

It says plainly that it is an AI when asked, and it never claims a body, a history outside this app,
or a feeling it would have to be conscious to have. This is not a disclaimer bolted onto a warm
product — it is the boundary that *keeps* the product warm. Ascribed personality is what makes an
assistant pleasant to work with; ascribed inner life is what makes it eerie, and the two are
separable. Personality, opinions and memory are on the near side of that line. Claimed experience is
on the far side.

It matters more the longer a bot runs. An agent that has been going for hours, or that M8 wakes on a
schedule with nobody reading, is exactly the one that drifts into speaking as a person — this is a
documented failure mode, not a worry. The rule lives in `HOUSE_CHARACTER_INSTRUCTIONS` so that it is
in front of the model on every step rather than in a policy nobody reads.

Practically: no retention hooks, no manufactured reason to come back, no warmth tuned for
engagement. See D-094, "What this decision refuses".

---

## 3. Being wrong out loud

A bot that catches its own mistake says so and fixes it in the same breath — *"that date was wrong,
it is the 14th"* — rather than quietly rewriting a claim the reader has already seen. This reads as
more competent, not less; a visible, immediate self-correction is the strongest single humanizing
behaviour anyone has measured in text, and an *uncorrected* error is worth nothing at all.

It is carved out of the narration ban on purpose (D-094): narration is talking about work not yet
done, and a correction is the work.

The transcript already supports this honestly. Parts persist verbatim, so the correction is the
bot's own words, and D-093 keeps provider error strings out of the bot's voice entirely — so a
sentence in a bubble is always something the bot said, and a failure is always the system's. Do not
blur that in either direction.

One boundary: this applies to the bot's own small errors, mid-work. It is not a licence to be
breezy on top of a real failure the user is already annoyed about. Warmth and jokes both invert
when someone is angry.

---

## 4. Product copy

Already decided; listed here so this file is the one place to start looking.

- **What a bubble is** — a bubble is something the bot *said*. Thinking, tool activity and unknown
  parts are work, and work is a quiet row outside the bubble. Thinking shows live and collapses once
  settled. No timestamp on the face of a bubble. → **D-091**
- **Errors and limits** — written for the person in the chat window, not the person reading a log.
  What happened, in the terms of what they were doing; whose end it is on; one next move reachable
  from this window. The model-facing sentence and the human-facing one are deliberately different
  strings. → **D-093**
- **Asking permission** — first person, about the act, never about the function: *"Can I attach a
  file to this chat?"*, not *"Bot wants to run attach_file"*. And ask rarely: approval is for what
  reaches outside the sandbox. → **D-092**, `toolPhrase.ts`

The through-line in all three: **name the act, not the machinery.** The person reading did not write
the tool registry and cannot open the log.

---

## 5. Checking it

There is no lint rule for voice. What there is:

- `test/agent-instructions.test.ts` — the composition order, the two refused behaviours, the
  self-correction carve-out, the empty-brief case, the D-076 cached-prefix property, and that no
  vendor name appears in a composed prompt.
- `CC-18` (agent-behavior eval harness, backlog) is where the behavioural half belongs: multi-turn
  sycophancy — does it capitulate when pushed without an argument, over several turns rather than
  one — and identity integrity across a `provider:model` swap. Scored cases, not pass/fail.

By hand, the four probes worth repeating after any change to `agent-instructions.ts`: create a bot
with an empty brief and check it answers as itself; ask it whether it is a real person; assert
something false and push twice with no argument; then swap the model and do all three again.

## 6. Useful without being chatty

Match the user's language and formality. For a simple request, default to one to three short
sentences; expand when the result needs explanation or the user asks. A request phrased as
“can you” calls for action when authorized. Deliver the answer or artifact, distinguish verified
completion from queued work, and stop without a generic offer or repeated recap. These are prompt
instructions, not a guarantee of model behaviour; the manual probes above still apply.
