import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Eye, EyeOff, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from './api.js';
import { Brand } from './Brand.jsx';

function clearPrivateBrowserState() {
  try { localStorage.removeItem('tutor-intake-session'); } catch { /* Storage may be unavailable. */ }
  try { sessionStorage.removeItem('tutor-question-bank:v1'); } catch { /* Storage may be unavailable. */ }
}

function rememberUser(user) {
  try {
    const previous = localStorage.getItem('tutor-auth-user');
    if (previous !== user.userId) clearPrivateBrowserState();
    localStorage.setItem('tutor-auth-user', user.userId);
  } catch { clearPrivateBrowserState(); }
}

function AuthForm({ hasUsers, onAuthenticated, notice }) {
  const [mode, setMode] = useState(hasUsers ? 'login' : 'register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(null);
  const submitting = useRef(false);
  const registering = mode === 'register';
  useEffect(() => () => request.current?.abort(), []);

  function switchMode(next) {
    setMode(next); setError(''); setPassword(''); setConfirmation(''); setVisible(false);
  }

  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    if (registering && password !== confirmation) { setError('两次输入的密码不一致，请重新确认。'); return; }
    submitting.current = true;
    const controller = new AbortController(); request.current = controller;
    setPending(true); setError('');
    try {
      const result = await api(`/api/auth/${mode}`, { email: email.trim(), password }, controller.signal);
      onAuthenticated(result.user);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message);
    } finally {
      submitting.current = false;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <main className="auth-page">
    <section className="auth-card" aria-labelledby="auth-title">
      <Brand className="auth-brand"/>
      <h1 id="auth-title">{registering ? '创建账户' : '登录智教'}</h1>
      <p className="auth-intro">{registering ? '使用邮箱注册，开始备课与组卷。' : '继续你的教学与组卷工作。'}</p>
      {!hasUsers ? <p className="auth-first-account">首个注册账户将自动成为管理员。</p> : null}
      {notice ? <p className="auth-notice" role="status">{notice}</p> : null}
      <form onSubmit={submit} aria-busy={pending}>
        <label htmlFor="auth-email">邮箱</label>
        <input id="auth-email" name="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={pending}/>
        <label htmlFor="auth-password">密码</label>
        <div className="auth-password-field">
          <input id="auth-password" name="password" type={visible ? 'text' : 'password'} autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 8 : undefined} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={pending} aria-describedby={registering ? 'auth-password-help' : undefined}/>
          <button className="auth-password-toggle" type="button" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(value => !value)} disabled={pending}>{visible ? <EyeOff size={18} aria-hidden="true"/> : <Eye size={18} aria-hidden="true"/>}</button>
        </div>
        {registering ? <><p className="auth-field-help" id="auth-password-help">8～128 个字符。</p><label htmlFor="auth-confirmation">确认密码</label><input id="auth-confirmation" name="confirmation" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={8} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={pending}/></> : null}
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <button className="primary auth-submit" type="submit" disabled={pending}>{pending ? <><LoaderCircle className="spinning" size={18} aria-hidden="true"/>{registering ? '正在创建账户…' : '正在登录…'}</> : <>{registering ? '注册并登录' : '登录'}<ArrowRight size={18} aria-hidden="true"/></>}</button>
      </form>
      <p className="auth-switch">{registering ? '已有账户？' : '还没有账户？'}<button type="button" className="link-button" disabled={pending} onClick={() => switchMode(registering ? 'login' : 'register')}>{registering ? '登录' : '创建账户'}</button></p>
    </section>
  </main>;
}

export function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const loggingOut = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api('/api/auth/me', undefined, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.user) rememberUser(result.user);
      setSession(result);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const expired = () => {
      clearPrivateBrowserState(); setSession(previous => ({ ...previous, user: null, hasUsers: true }));
      setNotice('登录已过期，请重新登录。'); setLogoutError('');
    };
    window.addEventListener('tutor:unauthorized', expired);
    return () => window.removeEventListener('tutor:unauthorized', expired);
  }, []);

  async function logout() {
    if (loggingOut.current) return;
    loggingOut.current = true; setLogoutPending(true); setLogoutError('');
    try {
      await api('/api/auth/logout', {});
      clearPrivateBrowserState();
      setSession({ user: null, hasUsers: true }); setNotice('');
    } catch (failure) { setLogoutError(failure.message); }
    finally { loggingOut.current = false; setLogoutPending(false); }
  }

  if (!session) return <main className="auth-page"><section className="auth-card"><Brand className="auth-brand"/>{error ? <><p className="auth-error" role="alert">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} aria-hidden="true"/>重新连接</button></> : <p className="auth-loading" role="status"><LoaderCircle className="spinning" size={18} aria-hidden="true"/>正在检查登录状态…</p>}</section></main>;
  if (!session.user) return <AuthForm hasUsers={session.hasUsers} notice={notice} onAuthenticated={user => { rememberUser(user); setSession({ user, hasUsers: true }); setNotice(''); }}/>;
  return children({ user: session.user, onLogout: logout, logoutPending, logoutError });
}
