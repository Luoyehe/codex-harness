import { createContext, useContext, type ReactNode } from 'react';
import type { ServerDiagnosticsResponse } from '../../protocol/ts/v2/ServerDiagnosticsResponse';
import type { Api } from '../lib/api';
import { useResource } from './useResource';

const Snapshot = createContext<ReturnType<typeof useResource<ServerDiagnosticsResponse>> | null>(null);
export function DiagnosticsSnapshot({ api, epoch, visible, children }: {
  api: Api; epoch: string; visible: boolean; children: ReactNode;
}) {
  const state = useResource(epoch, signal => api.call<ServerDiagnosticsResponse>('server/diagnostics', {}, signal), visible);
  return <Snapshot.Provider value={state}>{children}</Snapshot.Provider>;
}
export function useDiagnostics(api: Api, epoch: string, visible = true) {
  const shared = useContext(Snapshot);
  const local = useResource(epoch, signal => api.call<ServerDiagnosticsResponse>('server/diagnostics', {}, signal), visible && !shared);
  return shared ?? local;
}
