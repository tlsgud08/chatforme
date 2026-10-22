import InterfaceIcon from './InterfaceIcon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Command } from '@/types/db';
import { showToast } from '@/lib/toast';
import { showConfirmDialog } from '@/lib/dialog';

interface Props {
  userId: string;
  onClose?: () => void;
  embedded?: boolean;
  onSelect?: (command: Command) => void;
  workId?: string;
  allowWorkCreate?: boolean;
}

type Tab = 'all' | 'work' | 'mine' | 'hub' | 'favorites';
type Draft = Pick<Command, 'name' | 'description' | 'prompt'>;
const emptyDraft: Draft = { name: '', description: '', prompt: '' };
const tabLabels: Record<Tab, string> = { all: '전체', work: '작품', mine: '내 명령어', hub: '명령어 허브', favorites: '즐겨찾기' };

export default function CommandMenu({ userId, onClose, onSelect, embedded = false, workId, allowWorkCreate = false }: Props) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [workNames, setWorkNames] = useState<Record<string,string>>({});
  const [tab, setTab] = useState<Tab>(allowWorkCreate ? 'work' : 'all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Command | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [viewing, setViewing] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewText, setPreviewText] = useState('');
  const contentRead = useRef<AbortController | null>(null);
  useEffect(() => () => contentRead.current?.abort(), []);

  async function load() {
    const fetchCommands=async()=>{
      const items:Command[]=[];
      for(let start=0;;start+=500){
        const {data,error}=await supabase.from('commands').select('id,owner_id,work_id,name,description,is_published,copied_from_id,created_at,updated_at')
          .order('updated_at',{ascending:false}).order('id',{ascending:false})
          .range(start,start+499);
        if(error)throw error;
        items.push(...((data??[])as Command[]));
        if((data??[]).length<500)return items;
      }
    };
    const fetchFavorites=async()=>{
      const ids:string[]=[];
      for(let start=0;;start+=500){
        const {data,error}=await supabase.from('command_favorites').select('command_id')
          .eq('user_id',userId).order('command_id').range(start,start+499);
        if(error)throw error;
        ids.push(...(data??[]).map(row=>row.command_id));
        if((data??[]).length<500)return ids;
      }
    };
    let next:Command[], favorites:string[];
    try{[next,favorites]=await Promise.all([fetchCommands(),fetchFavorites()]);}
    catch(error){showToast('명령어를 불러오지 못했습니다: '+(error instanceof Error?error.message:String(error)));return;}
    setCommands(next);
    setFavoriteIds(new Set(favorites));
    const workIds=[...new Set(next.map(item=>item.work_id).filter((id):id is string=>!!id))];
    if(workIds.length){const {data:works}=await supabase.from('works').select('id,title').in('id',workIds);setWorkNames(Object.fromEntries((works??[]).map(w=>[w.id,w.title])));}
    const ids = [...new Set(next.map((item) => item.owner_id))];
    if (ids.length) {
      const { data: profiles } = await supabase.from('public_profiles').select('id,display_name').in('id', ids);
      setAuthors(Object.fromEntries((profiles ?? []).map((profile) => [profile.id, profile.display_name || '이름 없음'])));
    }
  }

  useEffect(() => { void load(); }, [userId]);

  const searchTerm = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => commands.filter((command) => {
    const relevant = !command.work_id || !workId || command.work_id === workId;
    const inTab = tab === 'all'
      ? (command.work_id ? (!workId || command.work_id === workId) : (command.owner_id === userId || command.is_published))
      : tab === 'work'
        ? !!command.work_id && (!workId || command.work_id === workId)
        : tab === 'mine'
          ? !command.work_id && command.owner_id === userId
          : tab === 'hub'
            ? !command.work_id && command.is_published
            : favoriteIds.has(command.id);
    return relevant && inTab && (!searchTerm || `${command.name} ${command.description} ${authors[command.owner_id] ?? ''}`.toLocaleLowerCase().includes(searchTerm));
  }), [authors, commands, favoriteIds, searchTerm, tab, userId, workId]);

  async function readContent(item: Command): Promise<Command | null> {
    contentRead.current?.abort();
    const controller = new AbortController();
    contentRead.current = controller;
    try {
      const { data, error } = await supabase.from('commands').select('*').eq('id', item.id).abortSignal(controller.signal).single();
      if (controller.signal.aborted) return null;
      if (error || !data) throw error ?? new Error('본문에 접근할 수 없습니다.');
      return data as Command;
    } catch (error) {
      if (!controller.signal.aborted) showToast('본문 조회 실패: ' + (error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)));
      return null;
    }
  }

  async function chooseItem(item: Command) {
    if (embedded && viewing === item.id) { setViewing(null); return; }
    const full = await readContent(item);
    if (!full) return;
    if (embedded) { setPreviewText(full.prompt); setViewing(full.id); }
    else { onSelect?.(full); onClose?.(); }
  }

  async function toggleFavorite(command: Command) {
    if (command.work_id) return;
    const wasFavorite = favoriteIds.has(command.id);
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (wasFavorite) next.delete(command.id); else next.add(command.id);
      return next;
    });

    const { error } = wasFavorite
      ? await supabase.from('command_favorites').delete().eq('user_id', userId).eq('command_id', command.id)
      : await supabase.from('command_favorites').insert({ user_id: userId, command_id: command.id });
    if (error) {
      setFavoriteIds((current) => {
        const next = new Set(current);
        if (wasFavorite) next.add(command.id); else next.delete(command.id);
        return next;
      });
      showToast(`즐겨찾기를 변경하지 못했습니다: ${error.message}`);
      return;
    }
    showToast(wasFavorite ? '즐겨찾기에서 삭제했습니다.' : '즐겨찾기에 추가했습니다.');
  }

  async function beginEdit(command?: Command) {
    if (command) {
      const full = await readContent(command);
      if (!full) return;
      command = full;
    }
    setEditing(command ?? 'new');
    setDraft(command ? { name: command.name, description: command.description, prompt: command.prompt } : emptyDraft);
    setOpenMenu(null);
  }

  async function save() {
    const name = draft.name.trim().replace(/^\/+/, '');
    if (!name || !draft.prompt.trim()) { showToast('명령어 이름과 프롬프트 본문을 입력해 주세요.'); return; }
    setBusy(true);
    const payload = { name, description: draft.description.trim(), prompt: draft.prompt.trim() };
    const result = editing === 'new'
      ? await supabase.from('commands').insert({ ...payload, owner_id: userId, work_id: allowWorkCreate ? workId ?? null : null }).select('*').single()
      : await supabase.from('commands').update(payload).eq('id', editing!.id).select('*').single();
    setBusy(false);
    if (result.error) { showToast(`저장하지 못했습니다: ${result.error.message}`); return; }
    setEditing(null);
    showToast('명령어를 저장했습니다.');
    await load();
  }

  async function publish(command: Command, value: boolean) {
    if (command.work_id) return;
    setOpenMenu(null);
    const { error } = await supabase.from('commands').update({ is_published: value }).eq('id', command.id);
    if (error) showToast(error.message);
    else { showToast(value ? '명령어 허브에 공개했습니다.' : '명령어를 비공개로 전환했습니다.'); await load(); }
  }

  async function copy(command: Command) {
    const full = await readContent(command);
    if (!full) return;
    command = full;
    if (command.work_id) return;
    setOpenMenu(null);
    const base = command.name;
    const names = new Set(commands.filter((item) => item.owner_id === userId).map((item) => item.name));
    let name = base;
    for (let n = 2; names.has(name); n += 1) {
      const suffix = ` ${n}`;
      name = `${base.slice(0, 20 - suffix.length)}${suffix}`;
    }
    const { error } = await supabase.from('commands').insert({ owner_id: userId, name, description: command.description, prompt: command.prompt, copied_from_id: command.id, is_published: false });
    if (error) showToast(error.message);
    else { showToast('내 명령어로 독립 복사했습니다.'); setTab('mine'); await load(); }
  }

  async function remove(command: Command) {
    setOpenMenu(null);
    if (!await showConfirmDialog(`/${command.name} 명령어를 삭제할까요?`, '삭제한 명령어는 복구할 수 없습니다.', '삭제')) return;
    const { error } = await supabase.from('commands').delete().eq('id', command.id);
    if (error) showToast(error.message); else { showToast('명령어를 삭제했습니다.'); await load(); }
  }

  if (editing) return (
    <div className={embedded ? "flex w-full justify-center" : "fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"} onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}>
      <section className={embedded ? "flex w-full flex-col bg-bg p-4" : "flex max-h-[92dvh] w-full max-w-lg flex-col overflow-y-auto rounded-t-3xl bg-bg p-5 shadow-2xl sm:rounded-3xl"}>
        <header className="mb-5 flex items-center justify-between"><button onClick={() => setEditing(null)} aria-label="목록으로 돌아가기" className="text-xl text-slate-400"><InterfaceIcon name="back" /></button><h2 className="font-bold text-white">명령어 편집</h2><span className="w-5" /></header>
        <label className="mb-4 text-sm font-semibold text-slate-200">명령어 이름 <span className="text-red-400">*</span><span className="float-right text-xs font-normal text-slate-500">{draft.name.length}/20</span>
          <div className="mt-2 flex rounded-xl bg-surface px-3"><span className="py-3 text-slate-500">/</span><input maxLength={20} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value.replace(/^\/+/, '') })} className="min-w-0 flex-1 bg-transparent py-3 outline-none" placeholder="명령어" /></div>
        </label>
        <label className="mb-4 text-sm font-semibold text-slate-200">설명 <span className="text-red-400">*</span><span className="float-right text-xs font-normal text-slate-500">{draft.description.length}/100</span>
          <input maxLength={100} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-2 w-full rounded-xl bg-surface px-3 py-3 outline-none" placeholder="이 명령어가 하는 일" />
        </label>
        <label className="text-sm font-semibold text-slate-200">프롬프트 본문 <span className="text-red-400">*</span><span className="float-right text-xs font-normal text-slate-500">{draft.prompt.length}/4000</span>
          <textarea maxLength={4000} rows={10} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} className="mt-2 w-full resize-none rounded-xl bg-surface px-3 py-3 text-sm outline-none" placeholder="사용자 메시지와 함께 AI에 전달할 프롬프트" />
        </label>
        <button disabled={busy || !draft.name.trim() || !draft.prompt.trim()} onClick={() => void save()} className="mt-5 rounded-xl bg-brand py-3 font-semibold text-white disabled:opacity-40">저장</button>
      </section>
    </div>
  );

  return (
    <div className={embedded ? "w-full" : "fixed inset-0 z-40 flex items-end justify-center bg-black/60"} onMouseDown={(event) => !embedded && event.target === event.currentTarget && onClose?.()}>
      <section className={embedded ? "flex w-full flex-col bg-bg" : "flex h-[72dvh] w-full max-w-app flex-col rounded-t-3xl bg-bg shadow-2xl"}>
        <header className="flex items-center justify-between px-4 pb-2 pt-4"><div>{!embedded && <h2 className="text-lg font-bold text-white">명령어</h2>}<p className="text-xs text-slate-500">{embedded ? '명령어를 만들고 편집하거나 허브에 공개하세요.' : '메뉴에서 선택해야 명령어가 활성화됩니다.'}</p></div>{!embedded && <button onClick={onClose} aria-label="닫기" className="p-2 text-xl text-slate-400"><InterfaceIcon name="close" /></button>}</header>
        <div className="flex shrink-0 overflow-x-auto border-b border-surface2 px-3">
          {(['all', 'work', 'mine', 'hub', 'favorites'] as Tab[]).map((value) => <button key={value} onClick={() => { setTab(value); setOpenMenu(null); }} aria-pressed={tab === value} className={`whitespace-nowrap border-b-2 px-2.5 py-3 text-sm ${tab === value ? 'border-brand font-semibold text-white' : 'border-transparent text-slate-500'}`}>{tabLabels[value]}</button>)}
        </div>
        <div className="shrink-0 border-b border-surface2 p-3">
          <div className="flex items-center gap-2 rounded-xl bg-surface px-3">
            <input type="search" aria-label={`${tabLabels[tab]} 명령어 검색`} value={query}
              onChange={(event) => { setQuery(event.target.value); setOpenMenu(null); }}
              placeholder={`${tabLabels[tab]}에서 이름, 설명, 작성자 검색`}
              className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none" />
            {query && <button type="button" aria-label="검색어 지우기" onClick={() => setQuery('')}
              className="shrink-0 p-2 text-sm text-slate-400"><InterfaceIcon name="close" /></button>}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">{searchTerm ? `${tabLabels[tab]}에 검색 결과가 없습니다.` : '표시할 명령어가 없습니다.'}</p> : visible.map((command) => {
            const mine = command.work_id ? allowWorkCreate && command.work_id === workId : command.owner_id === userId;
            return <div key={command.id} className={`relative flex gap-3 border-b border-surface2/70 px-4 py-3 ${embedded ? 'flex-wrap' : ''}`}>
              <button onClick={() => void chooseItem(command)} className="min-w-0 flex-1 text-left">
                <p className="truncate font-semibold text-white"><span className="text-brand">/</span>{command.name} {command.work_id && <span className="ml-1 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand">작품 전용</span>} {mine && <span className="ml-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-400">나</span>} {command.is_published && <span className="ml-1 rounded bg-blue-400/15 px-1.5 py-0.5 text-[10px] text-blue-400">허브</span>}</p>
                <p className="mt-1 truncate text-xs text-slate-400">{command.description || '설명 없음'}</p>
                {command.work_id && <p className="mt-1 text-[11px] text-slate-500">작품 · {workNames[command.work_id]??'접근 가능한 작품'}</p>}
                {command.is_published && <p className="mt-1 text-[11px] text-slate-500">올린 사람 · {mine ? '나' : authors[command.owner_id] ?? '사용자'}</p>}
              </button>
              {embedded && viewing === command.id && <div className="order-last w-full rounded-lg bg-surface p-3">
                <p className="mb-2 text-xs font-semibold text-slate-400">프롬프트 본문</p>
                <pre className="whitespace-pre-wrap break-words text-sm text-slate-200">{previewText}</pre>
              </div>}
              <button disabled={!!command.work_id} aria-label={`/${command.name} ${favoriteIds.has(command.id) ? '즐겨찾기 해제' : '즐겨찾기 추가'}`} aria-pressed={favoriteIds.has(command.id)} onClick={() => void toggleFavorite(command)} className={`self-start px-1 text-2xl leading-none ${favoriteIds.has(command.id) ? 'text-amber-400' : 'text-slate-500'}`}><InterfaceIcon name="star" filled={favoriteIds.has(command.id)} /></button>
              <button aria-label="명령어 메뉴" onClick={() => setOpenMenu(openMenu === command.id ? null : command.id)} className="self-start px-1 text-xl text-slate-500"><InterfaceIcon name="more" /></button>
              {openMenu === command.id && <div className="absolute right-4 top-10 z-10 min-w-40 overflow-hidden rounded-xl border border-surface2 bg-surface shadow-xl">
                {mine ? <><button onClick={() => beginEdit(command)} className="block w-full px-4 py-2.5 text-left text-sm">명령어 수정</button>{!command.work_id && <button onClick={() => void publish(command, !command.is_published)} className="block w-full px-4 py-2.5 text-left text-sm">{command.is_published ? '허브에서 비공개' : '전체 공개'}</button>}<button onClick={() => void remove(command)} className="block w-full px-4 py-2.5 text-left text-sm text-red-400">삭제</button></> : !command.work_id && <button onClick={() => void copy(command)} className="block w-full px-4 py-2.5 text-left text-sm">내 명령어로 복사</button>}
              </div>}
            </div>;
          })}
        </div>
        <button onClick={() => beginEdit()} className="m-3 rounded-xl border border-brand/40 py-3 text-sm font-semibold text-brand">＋ {allowWorkCreate ? '작품 전용 명령어' : '명령어'} 추가</button>
      </section>
    </div>
  );
}
