import { Component, useEffect, useState, type ReactNode } from 'react';
import { Api } from './lib/api';
import { message } from './lib/types';
import { Login } from './components/Login';
import { DialogScope } from './components/Dialog';
import { Workspace } from './Workspace';

function SessionApp() {
  const [api] = useState(() => new Api()),
    [authenticated, setAuthenticated] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [workspaceOpened, setWorkspaceOpened] = useState(false),
    [externalAuthentication, setExternalAuthentication] = useState(false),
    [setupRequired, setSetupRequired] = useState(false);
  useEffect(
    () =>
      api.onAuthenticationLost((external) => {
        setAuthenticated(false);
        setExternalAuthentication(external);
        setError(
          external
            ? '站点访问认证已失效，请完成访问认证后重新检查登录。'
            : '登录已失效，请重新登录。草稿和操作恢复记录仍保留。',
        );
      }),
    [api],
  );
  useEffect(() => {
    let current = true;
    api
      .session()
      .then((s) => {
        if (current) {
          setAuthenticated(s.authenticated);
          setSetupRequired(s.setupRequired === true);
          if (s.authenticated) setWorkspaceOpened(true);
        }
      })
      .catch((e) => {
        if (current) setError(message(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api]);
  if (loading)
    return (
      <main className="loading-screen" role="status">
        <span className="brand-mark">⌘</span>
        <p>正在连接工作台…</p>
      </main>
    );
  // Retain even an unsaved in-memory draft while login is renewed. Hidden workspaces
  // disconnect their event channel; authentication recovery never replays writes.
  return (
    <>
      <DialogScope active={authenticated}>
        <div hidden={!authenticated}>
          {workspaceOpened && (
            <Workspace
              api={api}
              active={authenticated}
              logout={async () => {
                await api.logout();
                setAuthenticated(false);
              }}
            />
          )}
        </div>
      </DialogScope>
      {!authenticated && (
        <Login
          api={api}
          initialError={error}
          externalAuthentication={externalAuthentication}
          setupRequired={setupRequired}
          onLogin={() => {
            setError('');
            setSetupRequired(false);
            setExternalAuthentication(false);
            setWorkspaceOpened(true);
            setAuthenticated(true);
          }}
        />
      )}
    </>
  );
}
class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main className="loading-screen">
        <h1>工作台暂时无法打开</h1>
        <p role="alert">{this.state.error}</p>
        <p>页面遇到了无法恢复的错误。请保留错误信息并重新加载；未确认的操作不会自动重发。</p>
        <button className="button" onClick={() => location.reload()}>
          重新加载
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
export function App() {
  return (
    <Boundary>
      <SessionApp />
    </Boundary>
  );
}
