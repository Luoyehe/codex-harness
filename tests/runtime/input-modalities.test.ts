import { expect, test } from 'vitest';
import { mediaModalities, selectedInputModel, validateInputModalities } from '../../src/runtime/input-modalities.js';
import type { JsonObject, JsonValue } from '../../src/runtime/types.js';
const input = [{ type: 'localAudio', path: '/fixture.wav' }, { type: 'localImage', path: '/fixture.png' }];
const row = (inputModalities: string[]) => ({ id: 'catalog-id', model: 'model-alias', inputModalities });
test('media uses positive fresh native capabilities for the exact effective model, including hidden paginated entries', async () => {
  const calls: JsonValue[] = []; const native = async (_: string, params: JsonValue) => { calls.push(params); return calls.length === 1 ? { data: [row(['text', 'image', 'audio'])], nextCursor: 'next' } : { data: [], nextCursor: null }; };
  await validateInputModalities(native, 'model-alias', input); expect(calls).toEqual([{ includeHidden: true, limit: 100 }, { includeHidden: true, limit: 100, cursor: 'next' }]);
  expect(selectedInputModel({ model: 'ignored', collaborationMode: { settings: { model: 'plan-model' } } }, 'fallback')).toBe('plan-model'); expect(mediaModalities([{ type: 'text', text: 'file path' }])).toEqual([]);
});
test('unknown, missing, conflicting and unsupported catalog evidence cannot authorize media', async () => {
  for (const [model, data, code] of [[undefined, [row(['audio'])], 'model_capability_unknown'], ['missing', [row(['audio'])], 'model_capability_unknown'], ['catalog-id', [{ id: 'catalog-id' }], 'model_capability_unknown'], ['catalog-id', [row(['audio']), row(['image'])], 'model_capability_unknown'], ['catalog-id', [row(['text', 'image'])], 'model_modality_unsupported']] as [string | undefined, JsonObject[], string][]) {
    await expect(validateInputModalities(async () => ({ data, nextCursor: null }), model, input)).rejects.toMatchObject({ code, delivery: 'not_sent' });
  }
  let calls = 0; await validateInputModalities(async () => { calls++; return {}; }, undefined, [{ type: 'text', text: 'text only' }]); expect(calls).toBe(0);
});
test('a match on an incomplete or looping catalog page is insufficient evidence', async () => {
  await expect(validateInputModalities(async () => ({ data: [row(['text', 'image', 'audio'])], nextCursor: 'same' }), 'catalog-id', input)).rejects.toMatchObject({ code: 'model_capability_unknown' });
  let count = 0; await expect(validateInputModalities(async () => ({ data: count++ ? [] : [row(['text', 'image', 'audio'])], nextCursor: String(count) }), 'catalog-id', input)).rejects.toMatchObject({ code: 'model_capability_unknown' }); expect(count).toBe(32);
});
