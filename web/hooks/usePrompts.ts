import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { Events, useSubscription } from '../lib/events';
import { array, message, type HarnessEvent, type PromptRecord } from '../lib/types';
export function usePrompts(api: Api, events: Events, epoch: string) {
  const [prompts, setPrompts] = useState<PromptRecord[]>([]), [error, setError] = useState('');
  const generation = useRef(0), closed = useRef(new Set<string>()), current = useRef<PromptRecord[]>([]);
  const publish = (p: PromptRecord[]) => { current.current = p; setPrompts(p); };
  useEffect(() => { const gen = ++generation.current, controller = new AbortController(); closed.current.clear(); publish([]); setError(''); api.call('prompt/list', {}, controller.signal).then(value => { if (generation.current !== gen) return; const all = new Map([...array<PromptRecord>(value.prompts), ...current.current].filter(p => !closed.current.has(p.promptId)).map(p => [p.promptId, p])); publish([...all.values()]); }).catch(e => { if (generation.current === gen && !controller.signal.aborted) setError(message(e)); }); return () => { generation.current++; controller.abort(); }; }, [api, epoch]);
  const listener = useCallback((event: HarnessEvent) => { if (event.type === 'prompt') { const p = event.data as unknown as PromptRecord; if (typeof p.promptId !== 'string' || closed.current.has(p.promptId)) return; publish([...current.current.filter(v => v.promptId !== p.promptId), p]); } if (event.type === 'prompt-closed') { closed.current.add(String(event.data.promptId)); publish(current.current.filter(p => p.promptId !== event.data.promptId)); } }, []);
  useSubscription(events, listener);
  const answer = async (id: string, response: unknown) => { await api.mutate('prompt/answer', { promptId: id, response }); closed.current.add(id); publish(current.current.filter(p => p.promptId !== id)); };
  return { prompts, error, answer };
}
