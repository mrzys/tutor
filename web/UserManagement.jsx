import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Eye, EyeOff, KeyRound, LoaderCircle, Plus, RefreshCw, Search, Users, X } from 'lucide-react';
import { api } from './api.js';
import './UserManagement.css';

export function UserManagement({ currentUser, onClose }) {
  const dialog = useRef(null);
  const activeRequest = useRef(null);
  const submitting = useRef(false);
  const firstField = useRef(null);
  const createButton = useRef(null);
  const previousEditor = useRef(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    dialog.current.showModal();
    return () => activeRequest.current?.abort();
  }, []);
  useEffect(() => {
    if (editor) firstField.current?.focus();
    else if (previousEditor.current) createButton.current?.focus();
    previousEditor.current = editor;
  }, [editor]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    api('/api/auth/users', undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) setUsers(result.users);
    }).catch(failure => {
      if (!controller.signal.aborted) {
        setLoadError(failure.message);
        if (failure.status === 401) window.dispatchEvent(new Event('tutor:unauthorized'));
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);

  function openEditor(target) {
    setEditor(target); setEmail(''); setPassword(''); setConfirmation(''); setVisible(false); setError(''); setNotice('');
  }
  function back() { setEditor(null); setPassword(''); setConfirmation(''); setVisible(false); setError(''); }
  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    if (password !== confirmation) { setError('两次输入的密码不一致。'); return; }
    submitting.current = true; setPending(true); setError('');
    const controller = new AbortController(); activeRequest.current = controller;
    const creating = editor === 'create';
    try {
      const result = await api(creating ? '/api/auth/users' : `/api/auth/users/${editor.userId}/password`,
        creating ? { email: email.trim(), password } : { password }, controller.signal);
      if (controller.signal.aborted) return;
      if (creating) setUsers(previous => [result.user, ...previous]);
      setNotice(creating ? '用户已创建，可以使用邮箱和设置的密码登录。' : editor.userId === currentUser.userId
        ? '密码已修改，其他设备的登录已失效，当前登录已保留。' : '密码已修改，该用户需要使用新密码重新登录。');
      back();
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.message);
        if (failure.status === 401) window.dispatchEvent(new Event('tutor:unauthorized'));
      }
    } finally { submitting.current = false; if (!controller.signal.aborted) setPending(false); }
  }
  const filtered = users.filter(user => user.email.toLowerCase().includes(query.trim().toLowerCase()));
  const creating = editor === 'create';
  return createPortal(<dialog ref={dialog} className="user-management" aria-labelledby="user-management-title"
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget || pending) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}>
    <header className="user-management-header"><div><h2 id="user-management-title"><Users size={20} aria-hidden="true"/>用户管理</h2><p>创建教师账号，管理登录密码。</p></div>
      <button type="button" className="user-management-icon" aria-label="关闭用户管理" disabled={pending} onClick={onClose} autoFocus><X size={20} aria-hidden="true"/></button></header>
    <div className="user-management-body">
      {notice ? <p className="user-management-notice" role="status"><Check size={18} aria-hidden="true"/>{notice}</p> : null}
      {editor ? <>
        <button type="button" className="user-management-back" onClick={back} disabled={pending}><ArrowLeft size={16} aria-hidden="true"/>返回用户列表</button>
        <h3>{creating ? '创建用户' : '修改密码'}</h3>
        {!creating ? <p className="user-management-target">{editor.email}</p> : null}
        <form className="user-management-form" onSubmit={submit} aria-busy={pending}>
          {creating ? <><label htmlFor="managed-email">邮箱</label><input ref={creating ? firstField : null} id="managed-email" type="email" name="email" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={254} disabled={pending} value={email} onChange={event => setEmail(event.target.value)}/></> : null}
          <label htmlFor="managed-password">{creating ? '初始密码' : '新密码'}</label>
          <div className="user-management-password"><input ref={!creating ? firstField : null} id="managed-password" type={visible ? 'text' : 'password'} name="new-password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={pending} aria-describedby="managed-password-help"/>
            <button type="button" className="user-management-icon" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(value => !value)} disabled={pending}>{visible ? <EyeOff size={18} aria-hidden="true"/> : <Eye size={18} aria-hidden="true"/>}</button></div>
          <p id="managed-password-help" className="user-management-help">8～128 个字符。</p>
          <label htmlFor="managed-confirmation">确认密码</label><input id="managed-confirmation" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={8} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={pending}/>
          <p className="user-management-help">{creating ? '新账号默认拥有教师权限。' : editor.userId === currentUser.userId ? '修改后，其他设备上的登录将失效。' : '修改后，该用户在所有设备上的登录将失效。'}</p>
          {error ? <p className="user-management-error" role="alert">{error}</p> : null}
          <div className="user-management-actions"><button type="button" onClick={back} disabled={pending}>取消</button><button type="submit" className="primary" disabled={pending}>{pending ? <LoaderCircle size={17} className="spinning" aria-hidden="true"/> : null}{pending ? '正在保存…' : creating ? '创建用户' : '保存密码'}</button></div>
        </form>
      </> : <>
        <div className="user-management-toolbar"><label className="user-management-search"><Search size={17} aria-hidden="true"/><input type="search" aria-label="搜索用户" placeholder="搜索邮箱" value={query} onChange={event => setQuery(event.target.value)}/></label><button ref={createButton} type="button" className="primary" onClick={() => openEditor('create')}><Plus size={17} aria-hidden="true"/>创建用户</button></div>
        {loading ? <p className="user-management-loading" role="status"><LoaderCircle size={18} className="spinning" aria-hidden="true"/>正在读取用户…</p> : loadError ? <div role="alert"><p className="user-management-error">{loadError}</p><button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} aria-hidden="true"/>重新加载</button></div> : <>
          <p className="user-management-count">{query ? `匹配 ${filtered.length} 个用户` : `共 ${users.length} 个用户`}</p>
          <ul className="user-management-list">{filtered.map(user => <li key={user.userId}>
            <span className="account-avatar" aria-hidden="true">{(user.email.match(/[a-z]/i)?.[0] || user.email[0]).toUpperCase()}</span>
            <div className="user-management-identity"><strong>{user.email}</strong><span>{user.role === 'admin' ? '管理员' : '教师'}{user.userId === currentUser.userId ? ' · 当前账号' : ''}</span></div>
            <button type="button" className="user-management-reset" onClick={() => openEditor(user)} aria-label={`修改 ${user.email} 的密码`}><KeyRound size={16} aria-hidden="true"/><span>修改密码</span></button>
          </li>)}</ul>
          {!filtered.length ? <p className="user-management-empty">没有匹配的用户，试试其他邮箱。</p> : null}
        </>}
      </>}
    </div>
  </dialog>, document.body);
}
