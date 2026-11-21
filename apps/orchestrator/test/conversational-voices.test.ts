import { describe, expect, it } from 'vitest';
import { conversationalVoices } from '../src/models/voice/elevenlabs-voice.js';
import { HOUSE_VOICE_ID } from '../src/models/voice/voice-engine.js';

describe('the conversational voice catalog', () => {
  it('offers conversational voices and their samples, excluding performers even when their names sound friendly', () => {
    expect(
      conversationalVoices([
        {
          voiceId: HOUSE_VOICE_ID,
          name: 'Roger',
          labels: { use_case: 'conversational' },
          previewUrl: 'https://example.com/roger.mp3',
        },
        { voiceId: 'story', name: 'Warm and friendly', labels: { use_case: 'narrative_story' } },
        { voiceId: 'character', name: 'Relaxed', labels: { use_case: 'characters_animation' } },
        { voiceId: 'unknown', name: 'Conversational' },
        { voiceId: 'custom', labels: { use_case: ' Conversational ' } },
      ]),
    ).toEqual([
      { id: HOUSE_VOICE_ID, name: 'Roger', previewUrl: 'https://example.com/roger.mp3' },
      { id: 'custom', name: 'custom' },
    ]);
  });

  it('keeps a usable voice when its preview is missing or is not an HTTPS sample', () => {
    expect(
      conversationalVoices([
        {
          voiceId: 'voice',
          name: 'Voice',
          labels: { use_case: 'conversational' },
          previewUrl: 'javascript:alert(1)',
        },
      ]),
    ).toEqual([{ id: 'voice', name: 'Voice' }]);
  });
});
