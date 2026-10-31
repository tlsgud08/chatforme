import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';

type Person = { id: string; display_name: string };
type Grant = { user_id: string; created_at: string; name: string };
export default function SettingsAccessManager() {
  const { user, isAdmin } = useAuth();
  const [grants, setGrants] = useState<Grant[]>([]), [people, setPeople] = useState<Person[]>([]);
  const [search, setSearch] = useState(''), [message, setMessage] = useState(''), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const lock = useRef(false), alive = useRef(true), request = useRef<AbortController | null>(null);
  async function load(signal?: AbortSignal) {
    let query = supabase.from('settings_admins').select('user_id,created_at').order('created_at');
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as Omit<Grant, 'name'>[];
    let names: Person[] = [];
    if (rows.length) {
      let profiles = supabase.from('public_profiles').select('id,display_name').in('id', rows.map(row => row.user_id));
      if (signal) profiles = profiles.abortSignal(signal);
      const result = await profiles; if (result.error) throw result.error; names = result.data ?? [];
    }
    if (alive.current && !signal?.aborted) setGrants(rows.map(row => ({ ...row, name: names.find(person => person.id === row.user_id)?.display_name || '이름 없음' })));
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    if (isAdmin) void load(controller.signal).catch(error => { if (!controller.signal.aborted) setMessage(error.message); });
    return () => { alive.current = false; controller.abort(); request.current?.abort(); };
  }, [user?.id, isAdmin]);
  async function find() {
    const text = search.trim(); if (!text || !isAdmin) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setMessage('');
    try {
      let query = supabase.from('public_profiles').select('id,display_name');
      query = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(text) ? query.eq('id', text) : query.ilike('display_name', `%${text.replace(/[\\%_]/g, '\\$&')}%`);
      const { data, error } = await query.order('display_name').order('id').limit(20).abortSignal(controller.signal);
      if (error) throw error;
      if (alive.current && !controller.signal.aborted) { setPeople(data ?? []); if (!data?.length) setMessage('일치하는 사용자가 없어요.'); }
    } catch (error) { if (alive.current && !controller.signal.aborted) setMessage((error as Error).message); }
    finally { if (alive.current && !controller.signal.aborted) setLoading(false); }
  }
  async function change(id: string, grant: boolean) {
    if (!user || !isAdmin || lock.current) return;
    lock.current = true; setSaving(true); setMessage('');
    try {
      const query = grant ? supabase.from('settings_admins').insert({ user_id: id, granted_by: user.id }) : supabase.from('settings_admins').delete().eq('user_id', id);
      const { error } = await query;
      if (error) throw error;
      if (!alive.current) return;
      await load();
      if (alive.current) setMessage(grant ? '운영자 설정 권한을 부여했어요.' : '운영자 설정 권한을 회수했어요.');
    } catch (error) { if (alive.current) setMessage((error as Error).message); }
    finally { lock.current = false; if (alive.current) setSaving(false); }
  }
  if (!isAdmin) return null;
  return <section data-settings-section="admin" className="rounded-xl border border-brand/30 p-4">
    <h2 className="font-semibold">운영자 설정 접근 권한</h2>
    <p className="my-3 text-xs text-slate-400">지정한 사용자는 전역 프롬프트·모델·회원가입 마스터 비밀번호를 수정할 수 있어요. 권한 부여·회수는 기존 운영자만 할 수 있고 즉시 적용돼요. 다른 사용자의 비공개 작품·채팅 접근 권한은 부여되지 않아요.</p>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void find(); }}><input aria-label="권한을 부여할 사용자 검색" value={search} onChange={event => setSearch(event.target.value)} placeholder="닉네임 또는 사용자 ID" className="min-w-0 flex-1 rounded-lg bg-surface p-3 text-sm" /><button type="submit" disabled={loading || !search.trim()} className="rounded-lg bg-surface2 px-3 text-sm">{loading ? '검색 중…' : '사용자 검색'}</button></form>
    {people.map(person => <div key={person.id} className="mt-3 flex items-center gap-3 rounded-lg bg-surface p-3"><div className="min-w-0 flex-1"><p>{person.display_name || '이름 없음'}</p><p className="break-all text-xs text-slate-500">{person.id}</p></div><button type="button" disabled={saving || person.id === user?.id || grants.some(row => row.user_id === person.id)} onClick={() => void change(person.id, true)} className="shrink-0 text-sm text-brand disabled:opacity-40">{grants.some(row => row.user_id === person.id) ? '권한 있음' : '권한 부여'}</button></div>)}
    <h3 className="mb-2 mt-5 text-sm font-semibold">권한을 가진 사용자</h3>
    {!grants.length && <p className="text-xs text-slate-400">추가로 지정한 사용자가 없어요.</p>}
    {grants.map(row => <div key={row.user_id} className="mt-2 flex items-center gap-3 rounded-lg bg-surface p-3"><div className="min-w-0 flex-1"><p>{row.name}</p><p className="break-all text-xs text-slate-500">{row.user_id}</p></div><button type="button" disabled={saving} onClick={() => void change(row.user_id, false)} className="shrink-0 text-sm text-red-400 disabled:opacity-40">권한 회수</button></div>)}
    {message && <p role="status" className="mt-3 text-sm text-slate-400">{message}</p>}
  </section>;
}
