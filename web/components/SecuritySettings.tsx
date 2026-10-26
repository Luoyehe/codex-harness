import { useCallback, useEffect, useRef, useState } from 'react';
import { RpcError, type AccountAction, type AccountSecurity, type Api } from '../lib/api';
import { composing, message } from '../lib/types';

type Enrollment = { enrollmentId: string; secret: string; uri: string; expiresAt: number };
const date = (value: number) => new Date(value).toLocaleString();

export function SecuritySettings({ api, authenticated }: { api: Api; authenticated: boolean }) {
  const [account, setAccount] = useState<AccountSecurity>();
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [password, setPassword] = useState(''), [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment>(), [enrollmentCode, setEnrollmentCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const epoch = useRef(0), requestId = useRef(0), pending = useRef(false);
  const available = useRef(authenticated); available.current = authenticated;
  const clearSecrets = useCallback(() => {
    setPassword(''); setOtp(''); setNewPassword(''); setConfirmation('');
    setEnrollment(undefined); setEnrollmentCode(''); setRecoveryCodes([]);
  }, []);
  const read = useCallback(async () => {
    if (!available.current) return;
    const owner = epoch.current, request = ++requestId.current;
    setLoading(true); setError('');
    try {
      const result = await api.account();
      if (epoch.current !== owner || request !== requestId.current || !available.current) return;
      if (!result.revision || typeof result.mfaEnabled !== 'boolean' || !Array.isArray(result.sessions))
        throw new Error('账号状态不完整，暂时不能修改安全设置。');
      setAccount(result); setBlocked(false);
      if (result.mfaEnabled) { setEnrollment(undefined); setEnrollmentCode(''); }
    } catch (e) {
      if (epoch.current === owner && request === requestId.current) {
        setAccount(undefined); setError(message(e));
      }
    } finally {
      if (epoch.current === owner && request === requestId.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    epoch.current++; pending.current = false;
    clearSecrets(); setAccount(undefined); setBusy(''); setBlocked(false); setNotice('');
    if (authenticated) void read();
    return () => { epoch.current++; requestId.current++; pending.current = false; };
  }, [authenticated, read, clearSecrets]);
  useEffect(() => api.onAuthenticationLost(() => {
    epoch.current++; requestId.current++; pending.current = false;
    clearSecrets(); setAccount(undefined); setBusy(''); setLoading(false);
  }), [api, clearSecrets]);
  useEffect(() => {
    if (!enrollment) return;
    const timer = setTimeout(() => {
      setEnrollment(undefined); setEnrollmentCode('');
      setNotice('两步验证设置已过期，请重新发起设置。');
    }, Math.max(1, Math.min(2147483647, enrollment.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [enrollment]);
  const locked = !authenticated || !account || loading || Boolean(busy) || blocked;
  const verified = password.length > 0 && (!account?.mfaEnabled || otp.trim().length > 0);
  const act = async <T,>(action: AccountAction, params: Record<string, unknown>, success: (result: T) => void) => {
    if (locked || pending.current || !account) return;
    pending.current = true;
    const owner = epoch.current;
    setBusy(action); setError(''); setNotice('');
    setPassword(''); setOtp(''); setNewPassword(''); setConfirmation(''); setEnrollmentCode('');
    try {
      const result = await api.account<T>(action, { ...params, expectedRevision: account.revision });
      if (epoch.current !== owner || !available.current) return;
      success(result);
      await read();
    } catch (e) {
      if (epoch.current !== owner || !available.current) return;
      setError(message(e));
      if (!(e instanceof RpcError) || e.delivery !== 'not_sent' || e.code === 'account_changed') {
        setBlocked(true);
        setNotice('操作结果或账号版本需要核对。请重新读取状态，再决定下一步；不会自动重复提交。');
      }
    } finally {
      if (epoch.current === owner) { pending.current = false; setBusy(''); }
    }
  };
  const proof = () => ({ password, ...(otp.trim() ? { otp: otp.trim() } : {}) });
  return <section className="stack" aria-labelledby="account-security-title">
    <div className="section-heading">
      <div><h3 id="account-security-title">账号与安全</h3><p className="muted">管理工作台的单管理员账号，与模型供应商登录分别管理。</p></div>
      <button className="button small" disabled={!authenticated || loading || Boolean(busy)} onClick={() => void read()}>{loading ? '正在读取…' : '重新读取状态'}</button>
    </div>
    {!authenticated && <p className="muted">登录恢复后可管理账号安全；敏感输入已清除。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="muted" role="status">{notice}</p>}
    {account && <>
      <div className="info-card"><strong>{account.username}</strong><p className="small">两步验证：{account.mfaEnabled ? '已开启' : '未开启'}{account.mfaEnabled ? ` · 剩余恢复码 ${account.recoveryCodesRemaining} 个` : ''}</p></div>
      {recoveryCodes.length > 0 && <div className="info-card stack">
        <h4>保存恢复码</h4>
        <p>恢复码仅在这里展示一次，每个只能使用一次。请保存到密码管理器或其他安全位置。页面关闭后不会保留；重新生成会使旧恢复码全部失效。</p>
        <label className="field">新的恢复码<textarea readOnly rows={Math.min(10, recoveryCodes.length)} value={recoveryCodes.join('\n')} spellCheck={false} autoComplete="off" /></label>
        <button className="button" onClick={() => setRecoveryCodes([])}>我已保存，隐藏恢复码</button>
      </div>}
      <fieldset className="submission-fields stack" disabled={locked || recoveryCodes.length > 0}>
        <h4>安全验证</h4>
        <p className="small muted">修改密码或两步验证前，请验证当前密码。每次提交后会清除输入。</p>
        <label className="field">当前密码（安全验证）<input type="password" autoComplete="current-password" value={password} maxLength={512} onChange={(e) => setPassword(e.target.value)} /></label>
        {account.mfaEnabled && <label className="field">当前验证码或恢复码<input autoComplete="one-time-code" value={otp} maxLength={128} onChange={(e) => setOtp(e.target.value)} /></label>}
        <form className="stack" onKeyDown={(e) => { if (e.key === 'Enter' && composing(e)) e.preventDefault(); }} onSubmit={(e) => {
          e.preventDefault();
          if (!verified || (Array.from(newPassword).length < 12 || Array.from(newPassword).length > 256) || newPassword !== confirmation) return;
          void act('password', { currentPassword: password, password: newPassword, ...(otp.trim() ? { otp: otp.trim() } : {}) }, () => {});
        }}>
          <h4>修改密码</h4>
          <p className="small muted">密码为 12–256 个字符，空格会保留。修改成功后，所有设备会退出登录。</p>
          <label className="field">新密码<input type="password" autoComplete="new-password" value={newPassword} maxLength={512} onChange={(e) => setNewPassword(e.target.value)} required /></label>
          <label className="field">确认新密码<input type="password" autoComplete="new-password" value={confirmation} maxLength={512} onChange={(e) => setConfirmation(e.target.value)} required /></label>
          {confirmation && confirmation !== newPassword && <p className="error">两次输入的新密码不一致。</p>}
          <button className="button" type="submit" disabled={!verified || (Array.from(newPassword).length < 12 || Array.from(newPassword).length > 256) || newPassword !== confirmation}>{busy === 'password' ? '正在修改…' : '修改密码并退出所有设备'}</button>
        </form>
        <hr />
        <h4>两步验证</h4>
        {account.mfaEnabled ? <>
          <p className="small muted">登录时需要密码和验证器验证码，也可以使用一次性恢复码。修改两步验证设置会退出其他设备。如果恢复码响应丢失，重新读取状态后可再次验证身份并生成新码，之前的恢复码会全部失效。</p>
          <button className="button" disabled={!verified} onClick={() => void act<{ recoveryCodes: string[] }>('totp/recovery', proof(), (result) => {
            setRecoveryCodes(result.recoveryCodes); setNotice('已生成新的恢复码，旧码已失效；其他设备已退出登录。');
          })}>重新生成恢复码（旧码失效）</button>
          <button className="button" disabled={!verified} onClick={() => void act('totp/disable', proof(), () => {
            setNotice('两步验证已关闭，其他设备已退出登录。');
          })}>关闭两步验证</button>
        </> : <>
          <p className="small muted">使用支持 TOTP 的验证器。完成验证码校验后才会开启，并提供一次性恢复码。</p>
          {!enrollment && <button className="button" disabled={!verified} onClick={() => void act<Enrollment>('totp/start', proof(), (result) => {
            setEnrollment(result); setNotice('请在验证器中添加下方密钥，然后输入验证码完成设置。');
          })}>设置两步验证</button>}
          {enrollment && <div className="info-card stack">
            <p>在验证器中手动添加账号：{account.username}，服务名称：Codex Harness；选择基于时间的验证码。</p>
            <label className="field">验证器设置密钥<input readOnly value={enrollment.secret} autoComplete="off" spellCheck={false} /></label>
            <p className="small muted">此密钥仅用于添加验证器，请勿分享。设置将在 {date(enrollment.expiresAt)} 过期。</p>
            <label className="field">验证器生成的 6 位验证码<input inputMode="numeric" autoComplete="one-time-code" value={enrollmentCode} maxLength={6} onChange={(e) => setEnrollmentCode(e.target.value)} /></label>
            <button className="button primary" disabled={!/^\d{6}$/.test(enrollmentCode)} onClick={() => void act<{ recoveryCodes: string[] }>('totp/confirm', { enrollmentId: enrollment.enrollmentId, code: enrollmentCode }, (result) => {
              setEnrollment(undefined); setRecoveryCodes(result.recoveryCodes); setNotice('两步验证已开启，其他设备已退出登录。请保存恢复码。');
            })}>验证并开启两步验证</button>
            <button className="button" onClick={() => { setEnrollment(undefined); setEnrollmentCode(''); setNotice('未开启两步验证。未完成的设置会自动过期。'); }}>取消设置</button>
          </div>}
        </>}
      </fieldset>
      <hr />
      <h4>已登录设备</h4>
      <p className="small muted">设备名称来自浏览器标识，可能相同。撤销后，该设备的工作台连接和终端会关闭。</p>
      {account.sessions.map((session) => <div className="info-card" key={session.id}>
        <strong>{session.current ? '当前设备 · ' : ''}{session.label || '未命名浏览器'}</strong>
        <p className="small">登录：{date(session.createdAt)}<br />最近访问：{date(session.lastSeenAt)}<br />到期：{date(session.expiresAt)}</p>
        <button className="button small" disabled={locked} onClick={() => void act('sessions/revoke', { sessionId: session.id }, () => {
          setNotice('已撤销该设备的登录。');
        })}>{session.current ? '退出当前设备' : '撤销此设备登录'}</button>
      </div>)}
    </>}
  </section>;
}
