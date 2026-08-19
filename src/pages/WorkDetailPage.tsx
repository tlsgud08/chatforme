import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { guestCreateSession, guestAddMessage } from '@/lib/guest';
import { formatCount } from '@/lib/works';
import type { Persona, Profile, StartConfig, Work } from '@/types/db';
import ConfirmDialog from '@/components/ConfirmDialog';
import { showToast } from '@/lib/toast';

export default function WorkDetailPage() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const { user, isGuest, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>('');
  const [selectedConfigId, setSelectedConfigId] = useState<string>('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element).closest('[data-popup-menu]')) setMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

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
          turn_index: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null, cost: 0,
          is_hidden: true, created_at: now,
        });
      }
      if (selectedConfig?.initial_message.trim()) {
        guestAddMessage(session.id, {
          id: crypto.randomUUID(), role: 'assistant',
          content: selectedConfig.initial_message,
          turn_index: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null, cost: 0,
          is_hidden: false, created_at: now,
        });
      }
      navigate(`/chat/${session.id}`);
      return;
    }

    if (!user) { setStarting(false); return; }

    const { data: profileData } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    const profile = profileData as Profile | null;

    const { data, error } = await supabase
      .from('sessions')
      .insert({
        user_id: user.id,
        work_id: work.id,
        title: work.title,
        persona_id: selectedPersonaId || null,
        start_config_id: selectedConfigId || null,
        summary_model_override: profile?.summary_model || profile?.default_model || null,
        summary_reasoning_override: profile?.summary_reasoning ?? null,
        summary_interval_override: profile?.summary_interval ?? 30,
        summary_level_override: profile?.summary_level ?? 5,
        summary_allow_omission_override: profile?.summary_allow_omission ?? true,
        summary_parameters_enabled_override: profile?.summary_parameters_enabled ?? true,
        summary_source_mode_override: profile?.summary_source_mode ?? 'incremental',
        auto_summary_enabled: false,
        summary_cost_enabled_override: profile?.summary_cost_enabled ?? false,
        summary_cost_currency_override: profile?.summary_cost_currency ?? 'USD',
        summary_cost_threshold_override: profile?.summary_cost_threshold ?? 0,
      })
      .select('id').single();

    if (error) { showToast('채팅 시작에 실패했습니다: ' + error.message); setStarting(false); return; }

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

  async function deleteWork() {
    if (!work || !user || (!isAdmin && user.id !== work.creator_id)) return;
    setDeleting(true);
    let deleteQuery = supabase
      .from('works')
      .delete()
      .eq('id', work.id);
    if (!isAdmin) deleteQuery = deleteQuery.eq('creator_id', user.id);
    const { data, error } = await deleteQuery.select('id');
    setDeleting(false);

    if (error || !data?.length) {
      showToast(`삭제 실패: ${error?.message ?? '삭제 권한을 확인해주세요.'}`);
      return;
    }

    queryClient.removeQueries({ queryKey: ['work', work.id] });
    queryClient.setQueriesData({ queryKey: ['works-stats'] }, (old: unknown) =>
      Array.isArray(old) ? old.filter((item: Work) => item.id !== work.id) : old,
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['works-stats'] }),
      queryClient.invalidateQueries({ queryKey: ['my-works', user.id] }),
    ]);
    showToast('작품을 삭제했습니다.');
    navigate('/works', { replace: true });
  }

  if (isLoading) return <p className="p-6 text-slate-400">불러오는 중…</p>;
  if (!work) return <p className="p-6 text-amber-400">작품을 찾을 수 없습니다.</p>;

  const isCreator = user?.id === work.creator_id;
  if (work.visibility === 'private' && !isCreator && !isAdmin) {
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

      <div className="relative mt-4 flex items-start gap-2">
        <h1 className="flex-1 text-xl font-bold text-white">{work.title || '(제목 없음)'}</h1>
        {(isCreator || isAdmin) && (
          <div data-popup-menu className="relative shrink-0">
            <button
              type="button"
              aria-label="작품 관리 메뉴"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="px-2 text-2xl leading-none text-slate-400 active:text-white"
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-8 z-20 w-32 overflow-hidden rounded-lg border border-surface2 bg-surface shadow-xl">
                {isCreator && (
                  <button
                    type="button"
                    onClick={() => navigate(`/create/${work.id}`)}
                    className="w-full px-4 py-3 text-left text-sm text-white active:bg-surface2"
                  >
                    작품 수정
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}
                  className="w-full px-4 py-3 text-left text-sm text-red-400 active:bg-surface2"
                >
                  작품 삭제
                </button>
              </div>
            )}
          </div>
        )}
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
      {confirmDelete && (
        <ConfirmDialog
          title="작품을 삭제할까요?"
          description={`‘${work.title || '제목 없음'}’ 작품과 연결된 채팅 및 설정이 모두 삭제됩니다.\n이 작업은 되돌릴 수 없습니다.`}
          busy={deleting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void deleteWork()}
        />
      )}
    </div>
  );
}
