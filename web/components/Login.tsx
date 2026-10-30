import { useEffect, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import { composing, message } from '../lib/types';

export function Login({ api, onLogin, initialError, externalAuthentication = false, setupRequired = false }: {
  api: Api;
  onLogin: () => void;
  initialError?: string;
  externalAuthentication?: boolean;
  setupRequired?: boolean;
}) {
  const [username, setUsername] = useState(setupRequired ? 'admin' : '');
  const [password, setPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState('');
  const [token, setToken] = useState(''), [otp, setOtp] = useState('');
  const [remember, setRemember] = useState(false), [mfaRequired, setMfaRequired] = useState(false);
  const [setup, setSetup] = useState(setupRequired), [external, setExternal] = useState(externalAuthentication);
  const [error, setError] = useState(initialError ?? ''), [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setExternal(externalAuthentication); }, [externalAuthentication]);
  useEffect(() => { setSetup(setupRequired); }, [setupRequired]);
  const ready = !uncertain && username.length > 0 && password.length > 0 && (!setup || (token.trim().length > 0 && password === confirmPassword && Array.from(password).length >= 12 && Array.from(password).length <= 256)) && (!mfaRequired || otp.trim().length > 0);
  const checkSession = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const session = await api.session();
      if (!mounted.current) return;
      if (session.authenticated) onLogin();
      else { setExternal(false); setSetup(session.setupRequired === true); setUncertain(false); }
    } catch (e) { if (mounted.current) setError(message(e)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return (
    <main className="login-screen">
      <form className="login-card" onKeyDown={(e) => {
        if (e.key === 'Enter' && composing(e)) e.preventDefault();
      }} onSubmit={async (e) => {
        e.preventDefault();
        if (external || !ready || pending.current) return;
        pending.current = true; setBusy(true); setError('');
        try {
          const result = setup
            ? await api.setupAccount({ token: token.trim(), username, password })
            : await api.session({ username, password, remember, ...(otp.trim() ? { otp: otp.trim() } : {}) });
          if (!mounted.current) return;
          if (!result.authenticated) throw new Error('登录未成功。请重新检查账号状态。');
          setPassword(''); setConfirmPassword(''); setToken(''); setOtp('');
          onLogin();
        } catch (e) {
          if (!mounted.current) return;
          if (e instanceof RpcError && e.code === 'mfa_required' && e.delivery !== 'unknown') setMfaRequired(true);
          else { setPassword(''); setConfirmPassword(''); setOtp(''); setToken(''); }
          if (e instanceof RpcError && e.code === 'access_authentication_required') setExternal(true);
          if (e instanceof RpcError && e.delivery === 'unknown') setUncertain(true);
          setError(message(e));
        } finally {
          pending.current = false;
          if (mounted.current) setBusy(false);
        }
      }}>
        <div className="brand-mark" aria-hidden="true">⌘</div>
        <span className="product-name">Codex Harness</span>
        <h1>{setup ? '创建管理员账号' : '登录工作台'}</h1>
        {external ? <>
          <p className="muted">当前部署仍使用外部访问认证。请在新标签页完成认证，再回来检查登录。当前页面的草稿和操作记录会保留。</p>
          <a className="button primary" href={location.href} target="_blank" rel="noreferrer">在新标签页完成访问认证 ↗</a>
          <button type="button" className="button" disabled={busy} onClick={() => void checkSession()}>{busy ? '正在检查…' : '重新检查登录'}</button>
        </> : <>
          <p className="muted">{setup ? '使用服务器上的一次性初始化令牌创建单管理员账号。完成后，令牌不再用于网页登录。' : '使用工作台管理员账号登录。模型供应商的账号授权在进入工作台后管理。'}</p>
          <fieldset className="submission-fields stack" disabled={busy}>
            {setup && <label className="field">一次性初始化令牌
              <input name="bootstrap-token" type="password" autoComplete="off" value={token} maxLength={4096} onChange={(e) => setToken(e.target.value)} required />
            </label>}
            <label className="field">用户名
              <input name="username" autoComplete="username" value={username} maxLength={64} pattern="[A-Za-z0-9_.\-]+" onChange={(e) => { setUsername(e.target.value); setMfaRequired(false); setOtp(''); }} required autoFocus />
            </label>
            <label className="field">{setup ? '设置密码' : '密码'}
              <input name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} maxLength={512} onChange={(e) => { setPassword(e.target.value); setMfaRequired(false); setOtp(''); }} required />
            </label>
            {setup ? <>
              <p className="small muted">用户名使用字母、数字、下划线、点或短横线；密码为 12–256 个字符，空格会保留。</p>
              <label className="field">再次输入密码
                <input name="password-confirmation" type="password" autoComplete="new-password" value={confirmPassword} maxLength={512} onChange={(e) => setConfirmPassword(e.target.value)} required />
              </label>
              {confirmPassword && confirmPassword !== password && <p className="error">两次输入的密码不一致。</p>}
            </> : <>
              {mfaRequired && <label className="field">验证码或恢复码
                <input name="otp" autoComplete="one-time-code" value={otp} maxLength={128} onChange={(e) => setOtp(e.target.value)} required autoFocus />
              </label>}
              <label className="check-row"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />在此设备保持登录 30 天</label>
            </>}
            <button className="button primary" disabled={!ready} type="submit">{busy ? '正在验证…' : setup ? '创建账号并进入工作台' : '进入工作台 →'}</button>
          </fieldset>
          <p className="small muted">忘记密码时，可由服务器管理员通过 SSH 执行账号重置命令。</p>
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        {!external && (uncertain || error) && <button type="button" className="button" disabled={busy} onClick={() => void checkSession()}>重新检查账号状态</button>}
      </form>
    </main>
  );
}
