import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { Events, useSubscription } from '../lib/events';
import { array, message, type HarnessEvent, type PromptRecord } from '../lib/types';
// Bound the delta kept while a list travels independently of the event stream.
const maxClosedDuringList = 256;
export function usePrompts(api: Api, events: Events, epoch: string) {
  const [prompts, setPrompts] = useState<PromptRecord[]>([]),
    [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0),
    reading = useRef<{ closed: Set<string>; overflow: boolean } | null>(null),
    // The HTTP snapshot can introduce a prompt before its websocket open arrives.
    listedOnly = useRef(new Map<string, 'listed' | 'answered'>()),
    current = useRef<PromptRecord[]>([]);
  const publish = (p: PromptRecord[]) => {
    current.current = p;
    setPrompts(p);
  };
  useEffect(() => {
    const gen = ++generation.current,
      controller = new AbortController();
    const snapshot = { closed: new Set<string>(), overflow: false };
    reading.current = snapshot;
    listedOnly.current.clear();
    publish([]);
    setError('');
    api
      .call('prompt/list', {}, controller.signal)
      .then((value) => {
        if (generation.current !== gen) return;
        reading.current = null;
        if (snapshot.overflow) { setRevision(value => value + 1); return; }
        const all = new Map<string, PromptRecord>();
        const live = new Set(current.current.map(p => p.promptId));
        for (const p of array<PromptRecord>(value.prompts)) {
          if (snapshot.closed.has(p.promptId)) continue;
          all.set(p.promptId, p);
          if (!live.has(p.promptId)) listedOnly.current.set(p.promptId, 'listed');
        }
        snapshot.closed.clear();
        for (const p of current.current) all.set(p.promptId, p);
        publish([...all.values()]);
      })
      .catch((e) => {
        if (generation.current === gen && !controller.signal.aborted) {
          snapshot.closed.clear();
          reading.current = null;
          setError(message(e));
        }
      });
    return () => {
      generation.current++;
      snapshot.closed.clear();
      reading.current = null;
      controller.abort();
    };
  }, [api, epoch, revision]);
  function closeDuringList(id: string) {
    const snapshot = reading.current;
    if (!snapshot || snapshot.overflow) return;
    if (snapshot.closed.size >= maxClosedDuringList) {
      snapshot.overflow = true;
      snapshot.closed.clear();
    } else snapshot.closed.add(id);
  }
  const listener = useCallback((event: HarnessEvent) => {
    if (event.type === 'resync') { generation.current++; publish([]); setRevision(v => v + 1); return; }
    if (event.type === 'prompt') {
      const p = event.data as unknown as PromptRecord;
      if (typeof p.promptId !== 'string' || reading.current?.closed.has(p.promptId)) return;
      const alreadyAnswered = listedOnly.current.get(p.promptId) === 'answered';
      listedOnly.current.delete(p.promptId);
      if (alreadyAnswered) return;
      publish([...current.current.filter((v) => v.promptId !== p.promptId), p]);
    }
    if (event.type === 'prompt-closed') {
      if (typeof event.data.promptId !== 'string') return;
      closeDuringList(event.data.promptId);
      listedOnly.current.delete(event.data.promptId);
      publish(current.current.filter((p) => p.promptId !== event.data.promptId));
    }
  }, []);
  useSubscription(events, listener);
  const answer = async (id: string, response: unknown) => {
    if (!current.current.some(prompt => prompt.promptId === id)) throw new Error('此请求已失效，请重新核对。');
    const gen = generation.current;
    await api.mutate('prompt/answer', { promptId: id, response });
    if (gen !== generation.current) return;
    closeDuringList(id);
    if (listedOnly.current.has(id)) listedOnly.current.set(id, 'answered');
    publish(current.current.filter((p) => p.promptId !== id));
  };
  return { prompts, error, answer, refresh: () => setRevision(value => value + 1) };
}
