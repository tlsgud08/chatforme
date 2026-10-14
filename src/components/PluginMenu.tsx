import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Plugin } from '@/types/db';
import { showToast } from '@/lib/toast';
import { showConfirmDialog } from '@/lib/dialog';

interface Props {
  userId: string;
  onClose?: () => void;
  embedded?: boolean;
  onSelect?: (plugin: Plugin) => void;
  activeIds?: string[];
  selecting?: boolean;
}

type Tab = 'all' | 'mine' | 'hub' | 'favorites';
type Draft = Pick<Plugin, 'name' | 'description' | 'prompt'>;
const emptyDraft: Draft = { name: '', description: '', prompt: '' };
const tabLabels: Record<Tab, string> = { all: '전체', mine: '내 플러그인', hub: '플러그인 허브', favorites: '즐겨찾기' };

export default function PluginMenu({ userId, onClose, onSelect, activeIds = [], selecting = false, embedded = false }: Props) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Plugin | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [viewing, setViewing] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  async function load() {
    setLoading(true);
    setLoadError('');
    try {
      const next: Plugin[] = [];
      const favorites: { plugin_id: string }[] = [];
      // Fetch every page so each tab's search covers its entire accessible catalog.
      await Promise.all([
        (async () => {
          for (let from = 0; ; from += 500) {
            const { data, error } = await supabase.from('plugins').select('*')
              .or(`owner_id.eq.${userId},is_published.eq.true`)
              .order('updated_at', { ascending: false }).order('id').range(from, from + 499);
            if (error) throw error;
            next.push(...(data ?? []) as Plugin[]);
            if (!data || data.length < 500) break;
          }
        })(),
        (async () => {
          for (let from = 0; ; from += 500) {
            const { data, error } = await supabase.from('plugin_favorites').select('plugin_id')
              .eq('user_id', userId).order('plugin_id').range(from, from + 499);
            if (error) throw error;
            favorites.push(...(data ?? []));
            if (!data || data.length < 500) break;
          }
        })(),
      ]);
      setPlugins(next);
      setFavoriteIds(new Set(favorites.map((favorite) => favorite.plugin_id)));
      const ids = [...new Set(next.map((item) => item.owner_id))];
      if (ids.length) {
        const { data: profiles } = await supabase.from('profiles').select('id,display_name').in('id', ids);
        setAuthors(Object.fromEntries((profiles ?? []).map((profile) => [profile.id, profile.display_name || '이름 없음'])));
      }
    } catch {
      setLoadError('플러그인을 불러오지 못했습니다. DB 마이그레이션 적용 여부를 확인하고 다시 시도해 주세요.');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [userId]);

  const searchTerm = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => plugins.filter((plugin) => {
    const inTab = tab === 'all'
      ? plugin.owner_id === userId || plugin.is_published
      : tab === 'mine'
        ? plugin.owner_id === userId
        : tab === 'hub'
          ? plugin.is_published
          : favoriteIds.has(plugin.id);
    return inTab && (!searchTerm || `${plugin.name} ${plugin.description} ${authors[plugin.owner_id] ?? ''}`.toLocaleLowerCase().includes(searchTerm));
  }), [authors, plugins, favoriteIds, searchTerm, tab, userId]);

  async function toggleFavorite(plugin: Plugin) {
    const wasFavorite = favoriteIds.has(plugin.id);
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (wasFavorite) next.delete(plugin.id); else next.add(plugin.id);
      return next;
    });

    const { error } = wasFavorite
      ? await supabase.from('plugin_favorites').delete().eq('user_id', userId).eq('plugin_id', plugin.id)
      : await supabase.from('plugin_favorites').insert({ user_id: userId, plugin_id: plugin.id });
    if (error) {
      setFavoriteIds((current) => {
        const next = new Set(current);
        if (wasFavorite) next.add(plugin.id); else next.delete(plugin.id);
        return next;
      });
      showToast(`즐겨찾기를 변경하지 못했습니다: ${error.message}`);
      return;
    }
    showToast(wasFavorite ? '즐겨찾기에서 삭제했습니다.' : '즐겨찾기에 추가했습니다.');
  }

  function beginEdit(plugin?: Plugin) {
    setEditing(plugin ?? 'new');
    setDraft(plugin ? { name: plugin.name, description: plugin.description, prompt: plugin.prompt } : emptyDraft);
    setOpenMenu(null);
  }

  async function save() {
    const name = draft.name.trim();
    if (!name || !draft.prompt.trim()) { showToast('플러그인 이름과 프롬프트 본문을 입력해 주세요.'); return; }
    setBusy(true);
    const payload = { name, description: draft.description.trim(), prompt: draft.prompt.trim() };
    const result = editing === 'new'
      ? await supabase.from('plugins').insert({ ...payload, owner_id: userId }).select('*').single()
      : await supabase.from('plugins').update(payload).eq('id', editing!.id).select('*').single();
    setBusy(false);
    if (result.error) { showToast(`저장하지 못했습니다: ${result.error.message}`); return; }
    setEditing(null);
    showToast('플러그인을 저장했습니다.');
    await load();
  }

  async function publish(plugin: Plugin, value: boolean) {
    setOpenMenu(null);
    const { error } = await supabase.from('plugins').update({ is_published: value }).eq('id', plugin.id);
    if (error) showToast(error.message);
    else { showToast(value ? '플러그인 허브에 공개했습니다.' : '플러그인을 비공개로 전환했습니다.'); await load(); }
  }

  async function copy(plugin: Plugin) {
    setOpenMenu(null);
    const base = plugin.name;
    const names = new Set(plugins.filter((item) => item.owner_id === userId).map((item) => item.name));
    let name = base;
    for (let n = 2; names.has(name); n += 1) {
      const suffix = ` ${n}`;
      name = `${base}${suffix}`;
    }
    const { error } = await supabase.from('plugins').insert({ owner_id: userId, name, description: plugin.description, prompt: plugin.prompt, copied_from_id: plugin.id, is_published: false });
    if (error) showToast(error.message);
    else { showToast('내 플러그인으로 독립 복사했습니다.'); setTab('mine'); await load(); }
  }

  async function remove(plugin: Plugin) {
    setOpenMenu(null);
    if (!await showConfirmDialog(`${plugin.name} 플러그인을 삭제할까요?`, '삭제한 플러그인은 복구할 수 없습니다.', '삭제')) return;
    const { error } = await supabase.from('plugins').delete().eq('id', plugin.id);
    if (error) showToast(error.message); else { showToast('플러그인을 삭제했습니다.'); await load(); }
  }

  if (editing) return (
    <div className={embedded ? "flex w-full justify-center" : "fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"} onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}>
      <section className={embedded ? "flex w-full flex-col bg-bg p-4" : "flex max-h-[92dvh] w-full max-w-lg flex-col overflow-y-auto rounded-t-3xl bg-bg p-5 shadow-2xl sm:rounded-3xl"}>
        <header className="mb-5 flex items-center justify-between"><button onClick={() => setEditing(null)} className="text-xl text-slate-400">←</button><h2 className="font-bold text-white">플러그인 편집</h2><span className="w-5" /></header>
        <label className="mb-4 text-sm font-semibold text-slate-200">플러그인 이름 <span className="text-red-400">*</span><span className="float-right text-xs font-normal text-slate-500">{draft.name.length.toLocaleString('ko-KR')}자</span>
          <div className="mt-2 flex rounded-xl bg-surface px-3"><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="min-w-0 flex-1 bg-transparent py-3 outline-none" placeholder="플러그인" /></div>
        </label>
        <label className="mb-4 text-sm font-semibold text-slate-200">설명 <span className="text-red-400">*</span><span className="float-right text-xs font-normal text-slate-500">{draft.description.length.toLocaleString('ko-KR')}자</span>
          <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-2 w-full rounded-xl bg-surface px-3 py-3 outline-none" placeholder="이 플러그인이 하는 일" />
        </label>
        <label className="text-sm font-semibold text-slate-200">프롬프트 본문 <span className="text-red-400">*</span><span className="float-right text-xs font-normal text-slate-500">{draft.prompt.length.toLocaleString('ko-KR')}자</span>
          <textarea rows={10} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} className="mt-2 w-full resize-none rounded-xl bg-surface px-3 py-3 text-sm outline-none" placeholder="활성화 중 매 요청에 AI에게 전달할 프롬프트" />
        </label>
        <button disabled={busy || !draft.name.trim() || !draft.prompt.trim()} onClick={() => void save()} className="mt-5 rounded-xl bg-brand py-3 font-semibold text-white disabled:opacity-40">저장</button>
      </section>
    </div>
  );

  return (
    <div className={embedded ? "w-full" : "fixed inset-0 z-40 flex items-end justify-center bg-black/60"} onMouseDown={(event) => !embedded && event.target === event.currentTarget && onClose?.()}>
      <section className={embedded ? "flex w-full flex-col bg-bg" : "flex h-[72dvh] w-full max-w-app flex-col rounded-t-3xl bg-bg shadow-2xl"}>
        <header className="flex items-center justify-between px-4 pb-2 pt-4"><div>{!embedded && <h2 className="text-lg font-bold text-white">플러그인</h2>}<p className="text-xs text-slate-500">{embedded ? '플러그인을 만들고 편집하거나 허브에 공개하세요.' : '선택한 플러그인은 끌 때까지 매 채팅 요청에 포함됩니다.'}</p></div>{!embedded && <button onClick={onClose} className="p-2 text-xl text-slate-400">×</button>}</header>
        <div className="flex shrink-0 overflow-x-auto border-b border-surface2 px-3">
          {(['all', 'mine', 'hub', 'favorites'] as Tab[]).map((value) => <button key={value} onClick={() => { setTab(value); setOpenMenu(null); }} aria-pressed={tab === value} className={`whitespace-nowrap border-b-2 px-2.5 py-3 text-sm ${tab === value ? 'border-brand font-semibold text-white' : 'border-transparent text-slate-500'}`}>{tabLabels[value]}</button>)}
        </div>
        <div className="shrink-0 border-b border-surface2 p-3">
          <div className="flex items-center gap-2 rounded-xl bg-surface px-3">
            <input type="search" aria-label={`${tabLabels[tab]} 플러그인 검색`} value={query}
              onChange={(event) => { setQuery(event.target.value); setOpenMenu(null); }}
              placeholder={`${tabLabels[tab]}에서 이름, 설명, 작성자 검색`}
              className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none" />
            {query && <button type="button" aria-label="검색어 지우기" onClick={() => setQuery('')}
              className="shrink-0 p-2 text-sm text-slate-400">×</button>}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? <p className="p-8 text-center text-sm text-slate-500">불러오는 중…</p> : loadError ?
            <div role="alert" className="p-4 text-sm text-amber-400">{loadError}<button type="button" onClick={() => void load()} className="mt-2 block underline">다시 불러오기</button></div> : visible.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">{searchTerm ? `${tabLabels[tab]}에 검색 결과가 없습니다.` : '표시할 플러그인이 없습니다.'}</p> : visible.map((plugin) => {
            const mine = plugin.owner_id === userId;
            return <div key={plugin.id} className={`relative flex gap-3 border-b border-surface2/70 px-4 py-3 ${embedded ? 'flex-wrap' : ''}`}>
              <button disabled={selecting || activeIds.includes(plugin.id)} onClick={() => { if (embedded) setViewing(viewing === plugin.id ? null : plugin.id); else onSelect?.(plugin); }} className="min-w-0 flex-1 text-left disabled:opacity-50">
                <p className="truncate font-semibold text-white">{plugin.name} {activeIds.includes(plugin.id) && <span className="ml-1 text-[10px] text-emerald-400">활성화됨</span>} {mine && <span className="ml-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-400">나</span>} {plugin.is_published && <span className="ml-1 rounded bg-blue-400/15 px-1.5 py-0.5 text-[10px] text-blue-400">허브</span>}</p>
                <p className="mt-1 truncate text-xs text-slate-400">{plugin.description || '설명 없음'}</p>
                {plugin.is_published && <p className="mt-1 text-[11px] text-slate-500">올린 사람 · {mine ? '나' : authors[plugin.owner_id] ?? '사용자'}</p>}
              </button>
              {embedded && viewing === plugin.id && <div className="order-last w-full rounded-lg bg-surface p-3">
                <p className="mb-2 text-xs font-semibold text-slate-400">프롬프트 본문</p>
                <pre className="whitespace-pre-wrap break-words text-sm text-slate-200">{plugin.prompt}</pre>
              </div>}
              <button aria-label={`${plugin.name} ${favoriteIds.has(plugin.id) ? '즐겨찾기 해제' : '즐겨찾기 추가'}`} aria-pressed={favoriteIds.has(plugin.id)} onClick={() => void toggleFavorite(plugin)} className={`self-start px-1 text-2xl leading-none ${favoriteIds.has(plugin.id) ? 'text-amber-400' : 'text-slate-500'}`}>{favoriteIds.has(plugin.id) ? '★' : '☆'}</button>
              <button aria-label="플러그인 메뉴" onClick={() => setOpenMenu(openMenu === plugin.id ? null : plugin.id)} className="self-start px-1 text-xl text-slate-500">⋯</button>
              {openMenu === plugin.id && <div className="absolute right-4 top-10 z-10 min-w-40 overflow-hidden rounded-xl border border-surface2 bg-surface shadow-xl">
                {mine ? <><button onClick={() => beginEdit(plugin)} className="block w-full px-4 py-2.5 text-left text-sm">플러그인 수정</button><button onClick={() => void publish(plugin, !plugin.is_published)} className="block w-full px-4 py-2.5 text-left text-sm">{plugin.is_published ? '허브에서 비공개' : '전체 공개'}</button><button onClick={() => void remove(plugin)} className="block w-full px-4 py-2.5 text-left text-sm text-red-400">삭제</button></> : <button onClick={() => void copy(plugin)} className="block w-full px-4 py-2.5 text-left text-sm">내 플러그인으로 복사</button>}
              </div>}
            </div>;
          })}
        </div>
        <button disabled={loading || !!loadError} onClick={() => beginEdit()} className="m-3 rounded-xl border border-brand/40 py-3 text-sm font-semibold text-brand disabled:opacity-50">＋ 플러그인 추가</button>
      </section>
    </div>
  );
}
