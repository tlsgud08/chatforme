import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { defaultReasoningFor } from '@/lib/llm/modelCapabilities';
import type { ReasoningSelection } from '@/lib/llm/types';
import { loadFavoriteModels, modelsFor } from '@/lib/modelPreferences';
import { showToast } from '@/lib/toast';
import ModelSelector from '@/components/ModelSelector';
import Dropdown from '@/components/Dropdown';

type WorkOption = { id: string; title: string };

export default function MultichatCreatePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedWorkId = searchParams.get('workId') ?? '';
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [workId, setWorkId] = useState('');
  const [title, setTitle] = useState('멀티챗');
  const [password, setPassword] = useState('');
  const initialModel = loadFavoriteModels()[0] ?? modelsFor('openrouter')[0] ?? 'openai/gpt-4o-mini';
  const [model, setModel] = useState(initialModel);
  const [reasoning, setReasoning] = useState<ReasoningSelection>(() => defaultReasoningFor('openrouter', initialModel));
  const [favoriteModels, setFavoriteModels] = useState<string[]>(loadFavoriteModels);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const worksQuery = requestedWorkId
      ? supabase.from('works').select('id,title').eq('id', requestedWorkId)
      : supabase.from('works').select('id,title').or(`visibility.eq.public,creator_id.eq.${user?.id}`).order('updated_at',{ascending:false});

    void worksQuery.then(({ data, error }) => {
      if (cancelled) return;
      const rows = (data as WorkOption[]) ?? [];
      setWorks(rows);
      if (error || rows.length === 0) {
        setWorkId('');
        if (requestedWorkId) showToast('선택한 작품을 불러올 수 없습니다.');
        return;
      }
      setWorkId(requestedWorkId || rows[0].id);
    });
    if (user) void supabase.from('profiles').select('favorite_models').eq('id', user.id).single().then(({ data }) => {
      if (cancelled) return;
      const favorites = Array.isArray(data?.favorite_models) ? data.favorite_models.filter((item): item is string => typeof item === 'string') : [];
      setFavoriteModels(favorites);
      if (favorites.length > 0) {
        setModel(favorites[0]);
        setReasoning(defaultReasoningFor('openrouter', favorites[0]));
      }
    });
    return () => { cancelled = true; };
  }, [user?.id, requestedWorkId]);

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
      {requestedWorkId ? (
        <div className="rounded-lg bg-surface p-3">
          <p className="text-xs text-slate-500">선택 작품</p>
          <p className="mt-1 font-semibold text-white">{works[0]?.title ?? '작품을 불러오는 중…'}</p>
        </div>
      ) : (
        <label className="block text-sm text-slate-300">작품<Dropdown className="mt-2" ariaLabel="작품 선택" value={workId} onChange={setWorkId} options={works.map((work) => ({ value: work.id, label: work.title }))} /></label>
      )}
      <label className="block text-sm text-slate-300">방 이름<input maxLength={60} value={title} onChange={e=>setTitle(e.target.value)} className="mt-2 w-full rounded-lg bg-surface p-3 text-white" /></label>
      <label className="block text-sm text-slate-300">비밀번호 (선택)<input type="password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-2 w-full rounded-lg bg-surface p-3 text-white" /></label>
      <div>
        <p className="mb-2 text-sm text-slate-300">방장 모델</p>
        <ModelSelector
          provider="openrouter"
          model={model}
          reasoning={reasoning}
          onModelChange={setModel}
          onReasoningChange={setReasoning}
          favoritesOnly
          hideReasoning
        />
        <p className="mt-2 text-xs text-slate-500">설정에서 즐겨찾기한 모델만 선택할 수 있습니다.</p>
        {favoriteModels.length === 0 && <p className="mt-1 text-xs text-amber-400">먼저 설정에서 사용할 모델을 즐겨찾기에 추가해 주세요.</p>}
      </div>
      <button disabled={busy||!workId||favoriteModels.length===0||!favoriteModels.includes(model)} className="w-full rounded-lg bg-brand py-3 font-semibold text-white disabled:opacity-40">{busy?'생성 중…':'로비 만들기'}</button>
    </form>
  </div>;
}
