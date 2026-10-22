import InterfaceIcon from '@/components/InterfaceIcon';
import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { formatCount } from '@/lib/works';
import type { Persona, StartConfig, Work } from '@/types/db';
import ConfirmDialog from '@/components/ConfirmDialog';
import { showToast } from '@/lib/toast';

export default function WorkDetailPage() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const { user, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const favoriteLock = useRef(false);
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
    enabled: !!user,
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
    enabled: !!workId && !!user,
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
    if (!user || favoriteLock.current) return;
    favoriteLock.current = true;
    try {
      const { error } = isFavorited
        ? await supabase.from('work_favorites').delete().eq('user_id', user.id).eq('work_id', workId!)
        : await supabase.from('work_favorites').insert({ user_id: user.id, work_id: workId });
      if (error) throw error;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['user-favorites', user.id] }),
        queryClient.invalidateQueries({ queryKey: ['work-fav-me', workId] }),
        queryClient.invalidateQueries({ queryKey: ['work-fav-count', workId] }),
      ]);
    } catch (error) { showToast('하트 변경 실패: ' + (error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error))); }
    finally { favoriteLock.current = false; }
  }

  async function startChat() {
    if (!work) return;
    setStarting(true);

    if (!user) { setStarting(false); return; }
    const { data: sessionId, error } = await supabase.rpc('create_session_with_start', {
      target_work: work.id, target_persona: selectedPersonaId || null, target_config: selectedConfigId || null,
    });
    if (error || !sessionId) { showToast('채팅 시작에 실패했습니다: ' + (error?.message ?? '저장 결과가 없습니다.')); setStarting(false); return; }

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
    queryClient.setQueriesData({ queryKey: ['works-list'] }, (old: unknown) =>
      Array.isArray(old) ? old.filter((item: Work) => item.id !== work.id) : old,
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['works-list'] }),
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
    <div className="work-detail-page p-4">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-slate-400"><InterfaceIcon name="back" /> 뒤로</button>
      <div className="work-detail-grid">
      <div className="work-detail-cover mx-auto aspect-[2/3] w-full max-w-[240px] overflow-hidden rounded-xl bg-surface2">
        {work.thumbnail_url ? <img src={work.thumbnail_url} alt="" className="h-full w-full object-cover" /> : <div className="poster-fallback modern-only" aria-hidden="true"><small>작품</small><strong>{work.title || '(제목 없음)'}</strong></div>}
      </div>

      <div className="work-detail-main">
      <div className="work-detail-title relative mt-4 flex items-start gap-2">
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
              <InterfaceIcon name="more" />
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
        {user && (
          <button
            onClick={toggleFavorite}
            className="shrink-0 text-2xl leading-none"
            aria-label="하트"
          >
            <InterfaceIcon name="heart" filled={isFavorited} />
          </button>
        )}
      </div>

      <div className="mt-1 flex items-center gap-3 text-xs text-slate-400">
        <span><InterfaceIcon name="heart" /> {formatCount(favoriteCount)}</span>
      </div>

      <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">{work.description}</p>

      <div className="mt-6 flex flex-col gap-3">
        {personas.length > 0 && (
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
        {personas.length === 0 && (
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

        <div className="flex gap-2">
          <button
            onClick={startChat}
            disabled={starting}
            className="min-w-0 flex-1 rounded-lg bg-brand py-3 font-semibold text-white disabled:opacity-50"
          >
            {starting ? '시작 중…' : '새 채팅 시작'}
          </button>
          {(
            <button
              type="button"
              onClick={() => navigate(`/multichat/new?workId=${work.id}`)}
              className="shrink-0 rounded-lg bg-surface2 px-3 py-3 text-sm font-semibold text-slate-200 active:bg-surface"
            >
              멀티챗 생성
            </button>
          )}
        </div>
      </div>
      </div>
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
