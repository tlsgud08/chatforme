import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { guestCreateSession, guestAddMessage } from '@/lib/guest';
import { formatCount } from '@/lib/works';
import type { Persona, StartConfig, Work } from '@/types/db';

export default function WorkDetailPage() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const { user, isGuest } = useAuth();
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>('');
  const [selectedConfigId, setSelectedConfigId] = useState<string>('');

  const { data: work, isLoading } = useQuery({
    queryKey: ['work', workId],
    queryFn: async () => {
      const { data, error } = await supabase.from('works').select('*').eq('id', workId).single();
      if (error) throw error;
      return data as Work;
    },
  });

  const { data: startConfigs = [] } = useQuery({
    queryKey: ['start-configs', workId],
    queryFn: async () => {
      const { data } = await supabase.from('start_configs').select('*').eq('work_id', workId).order('sort_order');
      return (data as StartConfig[]) ?? [];
    },
    enabled: !!workId,
  });

  const { data: personas = [] } = useQuery({
    queryKey: ['personas', user?.id],
    queryFn: async () => {
      const { data } = await supabase.from('personas').select('*').eq('user_id', user!.id).order('created_at');
      return (data as Persona[]) ?? [];
    },
    enabled: !!user && !isGuest,
  });

  const { data: totalPlays = 0 } = useQuery({
    queryKey: ['work-plays-total', workId],
    queryFn: async () => {
      const { count } = await supabase
        .from('work_plays')
        .select('*', { count: 'exact', head: true })
        .eq('work_id', workId!);
      return count ?? 0;
    },
    enabled: !!workId,
  });

  const { data: favoriteCount = 0 } = useQuery({
    queryKey: ['work-fav-count', workId],
    queryFn: async () => {
      const { count } = await supabase
        .from('work_favorites')
        .select('*', { count: 'exact', head: true })
        .eq('work_id', workId!);
      return count ?? 0;
    },
    enabled: !!workId,
  });

  const { data: isFavorited = false } = useQuery({
    queryKey: ['work-fav-me', workId, user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('work_favorites')
        .select('work_id')
        .eq('work_id', workId!)
        .eq('user_id', user!.id)
        .maybeSingle();
      return !!data;
    },
    enabled: !!workId && !!user && !isGuest,
  });

  useEffect(() => {
    if (personas.length > 0 && !selectedPersonaId) {
      const def = personas.find((p) => p.is_default) ?? personas[0];
      setSelectedPersonaId(def.id);
    }
  }, [personas]);

  useEffect(() => {
    if (startConfigs.length > 0 && !selectedConfigId) {
      const def = startConfigs.find((c) => c.is_default) ?? startConfigs[0];
      setSelectedConfigId(def.id);
    }
  }, [startConfigs]);

  async function toggleFavorite() {
    if (!user || isGuest) return;
    const newState = !isFavorited;
    queryClient.setQueryData(['work-fav-me', workId, user.id], newState);
    queryClient.setQueryData(['work-fav-count', workId], (old: number) => Math.max(0, old + (newState ? 1 : -1)));
    if (newState) {
      await supabase.from('work_favorites').insert({ user_id: user.id, work_id: workId });
    } else {
      await supabase.from('work_favorites').delete().eq('user_id', user.id).eq('work_id', workId!);
    }
    queryClient.invalidateQueries({ queryKey: ['user-favorites', user.id] });
  }

  async function startChat() {
    if (!work) return;
    setStarting(true);

    const selectedConfig = startConfigs.find((c) => c.id === selectedConfigId) ?? null;
    const now = new Date().toISOString();

    if (isGuest) {
      const session = guestCreateSession({ id: work.id, title: work.title });
      if (selectedConfig?.initial_context.trim()) {
        guestAddMessage(session.id, {
          id: crypto.randomUUID(), role: 'user',
          content: `[시작 설정: 아래 내용을 참고해 첫 장면을 시작하세요]\n\n${selectedConfig.initial_context}`,
          turn_index: 0, input_tokens: 0, output_tokens: 0, cost: 0,
          is_hidden: true, created_at: now,
        });
      }
      if (selectedConfig?.initial_message.trim()) {
        guestAddMessage(session.id, {
          id: crypto.randomUUID(), role: 'assistant',
          content: selectedConfig.initial_message,
          turn_index: 0, input_tokens: 0, output_tokens: 0, cost: 0,
          is_hidden: false, created_at: now,
        });
      }
      navigate(`/chat/${session.id}`);
      return;
    }

    if (!user) { setStarting(false); return; }

    const { data, error } = await supabase
      .from('sessions')
      .insert({
        user_id: user.id,
        work_id: work.id,
        title: work.title,
        persona_id: selectedPersonaId || null,
        start_config_id: selectedConfigId || null,
      })
      .select('id').single();

    if (error) { alert('채팅 시작에 실패했습니다: ' + error.message); setStarting(false); return; }

    const sessionId = data.id;

    if (selectedConfig?.initial_context.trim()) {
      await supabase.from('messages').insert({
        session_id: sessionId, role: 'user',
        content: `[시작 설정: 아래 내용을 참고해 첫 장면을 시작하세요]\n\n${selectedConfig.initial_context}`,
        turn_index: 0, is_hidden: true,
      });
    }
    if (selectedConfig?.initial_message.trim()) {
      await supabase.from('messages').insert({
        session_id: sessionId, role: 'assistant',
        content: selectedConfig.initial_message,
        turn_index: 0, is_hidden: false,
      });
    }

    setStarting(false);
    navigate(`/chat/${sessionId}`);
  }

  if (isLoading) return <p className="p-6 text-slate-400">불러오는 중…</p>;
  if (!work) return <p className="p-6 text-amber-400">작품을 찾을 수 없습니다.</p>;

  const isCreator = user?.id === work.creator_id;
  if (work.visibility === 'private' && !isCreator) {
    return (
      <div className="p-6 text-center">
        <p className="text-lg font-semibold text-white">비공개 작품입니다</p>
        <p className="mt-2 text-sm text-slate-400">제작자만 접근할 수 있습니다.</p>
        <button onClick={() => navigate(-1)} className="mt-4 text-sm text-slate-400 underline">뒤로</button>
      </div>
    );
  }

  return (
    <div className="p-4">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-slate-400">← 뒤로</button>
      <div className="mx-auto aspect-[2/3] w-full max-w-[240px] overflow-hidden rounded-xl bg-surface2">
        {work.thumbnail_url && <img src={work.thumbnail_url} alt="" className="h-full w-full object-cover" />}
      </div>

      <div className="mt-4 flex items-start gap-2">
        <h1 className="flex-1 text-xl font-bold text-white">{work.title || '(제목 없음)'}</h1>
        {user && !isGuest && (
          <button
            onClick={toggleFavorite}
            className="shrink-0 text-2xl leading-none"
            aria-label="하트"
          >
            {isFavorited ? '❤️' : '🤍'}
          </button>
        )}
      </div>

      <div className="mt-1 flex items-center gap-3 text-xs text-slate-400">
        <span>💬 {formatCount(totalPlays)} 대화</span>
        <span>❤️ {formatCount(favoriteCount)}</span>
      </div>

      <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">{work.description}</p>

      <div className="mt-6 flex flex-col gap-3">
        {!isGuest && personas.length > 0 && (
          <div>
            <label className="mb-1 block text-xs text-slate-400">페르소나</label>
            <select
              value={selectedPersonaId}
              onChange={(e) => setSelectedPersonaId(e.target.value)}
              className="w-full rounded-lg bg-surface px-4 py-2.5 text-sm outline-none"
            >
              {personas.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}
        {!isGuest && personas.length === 0 && (
          <p className="text-xs text-slate-500">
            페르소나 없음 — 설정 탭에서 추가하면 여기서 선택할 수 있습니다.
          </p>
        )}

        {startConfigs.length > 0 && (
          <div>
            <label className="mb-1 block text-xs text-slate-400">시작 설정</label>
            <select
              value={selectedConfigId}
              onChange={(e) => setSelectedConfigId(e.target.value)}
              className="w-full rounded-lg bg-surface px-4 py-2.5 text-sm outline-none"
            >
              {startConfigs.map((c) => (
                <option key={c.id} value={c.id}>{c.name || `설정 ${startConfigs.indexOf(c) + 1}`}</option>
              ))}
            </select>
          </div>
        )}

        <button
          onClick={startChat}
          disabled={starting}
          className="w-full rounded-lg bg-brand py-3 font-semibold text-white disabled:opacity-50"
        >
          {starting ? '시작 중…' : '새 채팅 시작'}
        </button>
      </div>
    </div>
  );
}
