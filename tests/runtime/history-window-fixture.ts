/// <reference lib="es2024.string" />
// The browser integration test also type-checks the Node 24 window projection.
import type { JsonObject } from '../../src/runtime/types.js';

export function longConversationData() {
  const makeTurn = (id: string, promptSize: number): JsonObject & { id: string; items: JsonObject[] } => ({ id, status: 'completed', itemsView: 'full', items: [
    { type: 'userMessage', id: 'prompt-' + id, content: [{ type: 'text', text: 'u'.repeat(promptSize), text_elements: [] }] },
    ...(id === 'latest' ? [{ type: 'agentMessage', id: 'progress', text: 'progress '.repeat(15000), phase: 'commentary', memoryCitation: null }] : []),
    { type: 'agentMessage', id: 'answer-' + id, text: id === 'latest' ? 'completed and visible final' : 'older reply', phase: 'final_answer', memoryCitation: null },
  ] });
  const turns = [makeTurn('latest', 900000), ...Array.from({ length: 5 }, (_, i) => makeTurn('older' + i, 800000))];
  const timeline = turns.toReversed().flatMap((turn, i) => turn.items.map((item, j) =>
    ({ type: 'item', position: i * 4 + j, turnId: turn.id, item })));
  return { turns, timeline };
}
