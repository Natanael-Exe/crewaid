# Voice mode

D-221 is the contract. This page covers how voice behaves and where its code lives. It is
unrelated to `docs/VOICE.md`, which is about how a bot writes.

## What a person can do

| Action | Where | What happens |
|---|---|---|
| **Dictate** | The mic beside Attach | Press it, speak, then press again. The words land at the caret, and the draft stays editable. Nothing is stored. Dictation stops itself at 2 minutes. |
| **Send a voice message** | The right slot of the composer, while the draft is empty | Press it, speak, then press Send, or press × to discard. The clip appears as a voice bubble. Hover it or focus its controls, then press the footer's info button to read the transcript. A message stops itself at 5 minutes and still sends. |
| **Hear the reply** | The reply to a voice message | The reply text arrives while audio is generated. Once the voice note arrives, it replaces the text bubbles and plays once, if the window has focus. The full reply text is in the footer's info popover. If no audio is generated, the text stays visible. |
| **Choose the bot's voice** | Bot settings → Voice | Only voices tagged conversational by ElevenLabs are offered. Press a row's play button to preview it, then choose the voice and save. "Default voice" is Roger. A previously saved voice remains set even if excluded from the picker. |

A reply is spoken only when the message it answers was a voice message. A typed message, an
uploaded audio file, a routine and a teammate's delivery all get a text reply only.

## The spoken register

When the trigger is a voice message, the model is told that its reply will be read aloud
(`SPOKEN_NOTE` in `agent/execution/provider-context.ts`). The instruction sits in that turn's user
content, so the bot's cached instructions do not change.

Before synthesis, `voice/speakable.ts` rewrites the reply for listening:

- A code block becomes "(a TypeScript code block)", and a table becomes "(a table)".
- A link becomes its text, and a bare URL becomes "a link".
- A path becomes its file name.
- Headings, list markers and emphasis are dropped.
- Past 2,500 characters, the reply stops at the last sentence that fits and ends with "The rest is
  in the chat."

## Keys

- **Cloud:** set `CREWAID_ELEVENLABS_API_KEY`, which needs billing on.
  - Transcription is charged per second of audio, and speech per character. Both come out of the
    plan's model allowance.
  - When the allowance is spent, every voice route answers `402 MODEL_ALLOWANCE_EXHAUSTED`.
- **Self-hosted:** add an "ElevenLabs (voice)" connection under Settings → Providers.
  - With none, the voice buttons are disabled and the routes answer `409`.

## Calls (D-222)

A call is a live voice line to a bot, from the phone button beside "Bot settings" in the right
rail. It is cloud only, and on Pro only: 30 minutes a billing period. An admin account has no
limit. On any other plan the button opens Settings → Plan & usage.

**The bot answers and the voice relays.** One shared ElevenLabs agent is the voice.
- Each request is handed to the bot, through `ask_bot`, as an ordinary chat message, so it
  appears in the thread like a typed one. The voice says once that it is on it.
- A request is answered when the server sends `run.settled` naming its message (D-227). That
  covers a run carried on past a step limit, a retried failure, and a message folded into a
  newer one's run. The reply is rewritten with `speakable()` and read aloud, after the voice
  finishes whatever it is saying.
- While the bot works, the voice is told what it is doing as "Work status" contextual updates:
  the current action and the tail of its visible narration, never reasoning or tool data. They
  are never answered aloud, so the voice knows how it is going when asked and says nothing
  otherwise.
- The voice does not fill the wait with "anything else?": while a request is open and the line
  is quiet, the desktop signals user activity, which resets the agent's silence timer. After
  45 s of quiet it asks the voice for one short check-in.
- Small talk the voice answers itself, briefly; anything needing work, facts or the user's
  context goes to the bot. Work in progress is never resent or forgotten while they talk.
- If the bot goes idle with a request open and nothing settles it (a worker that died), the
  call stops waiting after 20 s and says so.
- If the bot needs an approval, the voice asks the person to answer on screen. The card is still
  the only way to decide.
- The call bar shows the time, the minutes left, the voice's current line, mute and hang-up.
- The desktop hangs up at the call's budget, letting the voice finish its sentence first.

**Minutes come from ElevenLabs.** A call is settled to `call_duration_secs` once it ends, which
takes a few seconds (about 5–15 s in live runs). Until then it counts as its elapsed time.

### Setting up the agent

Do this once per deployment, in ElevenLabs or through its API or MCP:

1. **Create an agent.** Use LLM `gpt-4.1-mini` at temperature 0 and TTS `eleven_v4_turbo` with
   expressive mode off. Its own prompt is a fallback, because every call overrides it.
2. **Add a client tool `ask_bot`.** It takes one required string parameter, `request`, with
   `expects_response: false` and pre-tool speech off.
3. **Allow these client overrides:** `agent.prompt.prompt`, `agent.first_message`,
   `agent.language`, `tts.voice_id` and `conversation.max_duration_seconds`.
4. **Turn on authentication** (`enable_auth`), so only a signed URL starts a call. Set concurrency
   and daily caps.
5. **Set "take turn after silence" to 30 s** (`turn.turn_timeout`) and add `vad_score` to the
   client events (D-227). The desktop keeps the silence timer from firing while the bot works
   either way; the longer timeout keeps the voice from re-engaging during a pause in an
   ordinary conversation, and voice activity is what keeps an answer from landing on the
   person mid-sentence.
6. **Configure the server.** Set `CREWAID_ELEVENLABS_AGENT_ID` to the agent's id, alongside
   `CREWAID_ELEVENLABS_API_KEY` on the billing server.

The spike agent is `agent_3501m4x6c85remd95xgjb1v3apaf`, with tool
`tool_9101m4x6c112eq89xah6nhqf30kk`, and is configured exactly this way.

## Code map

| Concern | File |
|---|---|
| The ElevenLabs adapter (the only `@tanstack/ai-elevenlabs` import) | `apps/orchestrator/src/models/voice/elevenlabs-voice.ts` |
| The port, models and prices | `apps/orchestrator/src/models/voice/voice-engine.ts` |
| Routes and the choice of key | `apps/orchestrator/src/voice/voice.controller.ts`, `voice.service.ts` |
| Cloud metering | `apps/orchestrator/src/ee/billing/hosted-voice.service.ts` |
| Spoken replies | `apps/orchestrator/src/voice/spoken-reply.service.ts` |
| Recording | `apps/desktop/src/renderer/voice/recorder.ts` |
| Composer controls | `apps/desktop/src/renderer/components/composer/VoiceControls.tsx`, `useVoiceCapture.ts` |
| Playback | `apps/desktop/src/renderer/components/attachments/VoiceNoteBubble.tsx` |
| Microphone permission | `apps/desktop/src/mediaPermission.ts`, `resources/entitlements.mac.plist` |
| Calls: routes, minutes and settlement | `apps/orchestrator/src/ee/billing/voice-calls.service.ts`, `voice-calls.controller.ts` |
| Calls: the agent's REST API (signed URL, duration) | `apps/orchestrator/src/ee/voice/elevenlabs-agent.ts` |
| Calls: the session (the only `@elevenlabs/client` import) | `apps/desktop/src/renderer/voice/callSession.ts`, `useBotCall.ts` |
| Calls: the button, bar and thread bridge | `apps/desktop/src/renderer/components/call/CallControls.tsx` |

## Manual check

Run the local live orchestrator recipe with the selfhosted edition, the Docker sandbox and a
personal ElevenLabs key. Never use the Runtime provider on the shared key. Then:

1. Dictate into the draft, edit the text and send it.
2. Record a voice message. Its voice bubble should appear without a separate transcript bubble.
   Hover the bubble and press its footer's info button to read the transcript; also check that
   keyboard focus reveals the footer and Escape closes the popover.
3. The text reply should arrive first, then be replaced by the voice note and play. Its info
   popover should contain the full reply. A reply without generated audio should retain its text.
4. Open the voice picker. Previewing a voice should keep the picker open and leave Save disabled.
   Preview a second voice: the first should stop. Closing the picker should stop playback.
5. Choose a voice, save, and repeat steps 2–3.
