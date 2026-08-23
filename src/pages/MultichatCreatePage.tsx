import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { modelsFor } from '@/lib/modelPreferences';
import { showToast } from '@/lib/toast';

type WorkOption = { id: string; title: string };

export default function MultichatCreatePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [workId, setWorkId] = useState('');
  const [title, setTitle] = useState('멀티챗');
  const [password, setPassword] = useState('');
  const [model, setModel] = useState(modelsFor('openrouter')[0] ?? 'openai/gpt-4o-mini');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void supabase.from('works').select('id,title').or(`visibility.eq.public,creator_id.eq.${user?.id}`).order('updated_at',{ascending:false}).then(({data}) => { const rows=(data as WorkOption[])??[]; setWorks(rows); setWorkId(rows[0]?.id??''); }); }, [user?.id]);

  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!workId || !title.trim()) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('create_multichat', { target_work: workId, room_title: title.trim(), room_password: password, target_model: model, target_output_tokens: null });
    setBusy(false); if (error) { showToast('방 생성 실패: '+error.message); return; }
    navigate(`/multichat/${data}`);
  }

  return <div className="mx-auto max-w-lg p-5">
    <button onClick={() => navigate('/sessions')} className="mb-5 text-sm text-slate-400">← 채팅방</button>
    <h1 className="text-xl font-bold text-white">멀티챗 만들기</h1>
    <p className="mt-1 text-sm text-slate-400">정확히 두 명이 user1, user2가 되어 함께 AI와 대화합니다.</p>
    <form onSubmit={create} className="mt-6 space-y-4">
      <label className="block text-sm text-slate-300">작품<select value={workId} onChange={e=>setWorkId(e.target.value)} className="mt-2 w-full rounded-lg bg-surface p-3 text-white">{works.map(w=><option key={w.id} value={w.id}>{w.title}</option>)}</select></label>
      <label className="block text-sm text-slate-300">방 이름<input maxLength={60} value={title} onChange={e=>setTitle(e.target.value)} className="mt-2 w-full rounded-lg bg-surface p-3 text-white" /></label>
      <label className="block text-sm text-slate-300">비밀번호 (선택)<input type="password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-2 w-full rounded-lg bg-surface p-3 text-white" /></label>
      <label className="block text-sm text-slate-300">방장 모델<input value={model} onChange={e=>setModel(e.target.value)} className="mt-2 w-full rounded-lg bg-surface p-3 text-white" /></label>
      <button disabled={busy||!workId} className="w-full rounded-lg bg-brand py-3 font-semibold text-white disabled:opacity-40">{busy?'생성 중…':'로비 만들기'}</button>
    </form>
  </div>;
}
