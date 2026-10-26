import { useState } from 'react';
import type { Api } from '../lib/api';
import { composing, message } from '../lib/types';
export function Login({
  api,
  onLogin,
  initialError,
  externalAuthentication = false,
}: {
  api: Api;
  onLogin: () => void;
  initialError?: string;
  externalAuthentication?: boolean;
}) {
  const [token, setToken] = useState(''),
    [error, setError] = useState(initialError ?? ''),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-screen">
      <form
        className="login-card"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && composing(e)) e.preventDefault();
        }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (externalAuthentication || !token.trim() || busy) return;
          setBusy(true);
          setError('');
          try {
            const result = await api.session(token);
            if (!result.authenticated) throw new Error('登录未成功。');
            setToken('');
            onLogin();
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand-mark" aria-hidden="true">
          ⌘
        </div>
        <span className="eyebrow">CODEX HARNESS</span>
        <h1>你的工作，从这里继续。</h1>
        {externalAuthentication ? (
          <>
            <p className="muted">
              站点访问认证已失效。请在新标签页完成认证，再回到这里检查登录。当前页面的草稿和操作记录会保留，请保留此页面。
            </p>
            <a className="button primary" href={location.href} target="_blank" rel="noreferrer">
              在新标签页完成访问认证 ↗
            </a>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  const session = await api.session();
                  if (session.authenticated) onLogin();
                  else setError('访问认证已恢复，请输入管理员密钥登录工作台。');
                } catch (e) {
                  setError(message(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '正在检查…' : '重新检查登录'}
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              使用安装时生成的管理员密钥登录。通过本机或 SSH 访问也需要管理员认证。
            </p>
            <label className="field">
              管理员密钥
              <input
                name="token"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                autoFocus
              />
            </label>
            <button className="button primary" disabled={busy || !token.trim()} type="submit">
              {busy ? '正在连接…' : '进入工作台 →'}
            </button>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
