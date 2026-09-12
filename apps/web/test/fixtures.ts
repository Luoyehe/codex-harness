import type { Thread } from "../../../protocol/v2/Thread";
import type { ThreadItem } from "../../../protocol/v2/ThreadItem";
import type { Turn } from "../../../protocol/v2/Turn";

export function agent(id: string, text: string): Extract<ThreadItem, { type: "agentMessage" }> {
  return { type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null };
}

export function turn(id: string, items: ThreadItem[], status: Turn["status"] = "completed"): Turn {
  return { id, items, itemsView: "full", status, error: null, startedAt: null, completedAt: null, durationMs: null };
}

export function thread(id: string, turns: Turn[] = [], patch: Partial<Thread> = {}): Thread {
  return {
    id, sessionId: id, forkedFromId: null, parentThreadId: null, preview: id, ephemeral: false,
    section: null, sectionEnteredAt: null, projectId: null, modelProvider: "openai", createdAt: 1,
    updatedAt: 1, recencyAt: null, status: { type: "idle" }, path: null, cwd: "P", cliVersion: "test",
    source: "appServer", threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
    name: id, turns, ...patch,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
