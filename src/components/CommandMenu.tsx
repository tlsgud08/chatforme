import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Command } from '@/types/db';
import { showToast } from '@/lib/toast';

interface Props {
  userId: string;
  onClose: () => void;
  onSelect: (command: Command) => void;
}

type Tab = 'all' | 'mine' | 'hub';
type Draft = Pick<Command, 'name' | 'description' | 'prompt'>;
const emptyDraft: Draft = { name: '', description: '', prompt: '' };

export default function CommandMenu({ userId, onClose, onSelect }: Props) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Command | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data, error } = await supabase.from('commands').select('*').or(`owner_id.eq.${userId},is_published.eq.true`).order('updated_at', { ascending: false });
    if (error) { showToast(`명령어를 불러오지 못했습니다: ${error.message}`); return; }
    const next = (data as Command[]) ?? [];
    setCommands(next);
    const ids = [...new Set(next.map((item) => item.owner_id))];
    if (ids.length) {
      const { data: profiles } = await supabase.from('profiles').select('id,display_name').in('id', ids);
      setAuthors(Object.fromEntries((profiles ?? []).map((profile) => [profile.id, profile.display_name || '이름 없음'])));
    }
  }

  useEffect(() => { void load(); }, [userId]);

  const visible = useMemo(() => commands.filter((command) => {
    const inTab = tab === 'all' ? command.owner_id === userId || command.is_published : tab === 'mine' ? command.owner_id === userId : command.is_published;
    const term = query.trim().toLocaleLowerCase();
    return inTab && (!term || `${command.name} ${command.description} ${authors[command.owner_id] ?? ''}`.toLocaleLowerCase().includes(term));
  }), [authors, commands, query, tab, userId]);

  function beginEdit(command?: Command) {
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
      ? await supabase.from('commands').insert({ ...payload, owner_id: userId }).select('*').single()
      : await supabase.from('commands').update(payload).eq('id', editing!.id).select('*').single();
    setBusy(false);
    if (result.error) { showToast(`저장하지 못했습니다: ${result.error.message}`); return; }
    setEditing(null);
    showToast('명령어를 저장했습니다.');
    await load();
  }

  async function publish(command: Command, value: boolean) {
    setOpenMenu(null);
    const { error } = await supabase.from('commands').update({ is_published: value }).eq('id', command.id);
    if (error) showToast(error.message);
    else { showToast(value ? '명령어 허브에 공개했습니다.' : '명령어를 비공개로 전환했습니다.'); await load(); }
  }

  async function copy(command: Command) {
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
    if (!window.confirm(`/${command.name} 명령어를 삭제할까요?`)) return;
    const { error } = await supabase.from('commands').delete().eq('id', command.id);
    if (error) showToast(error.message); else { showToast('명령어를 삭제했습니다.'); await load(); }
  }

  if (editing) return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}>
      <section className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-3xl bg-bg p-5 shadow-2xl sm:rounded-3xl">
        <header className="mb-5 flex items-center justify-between"><button onClick={() => setEditing(null)} className="text-xl text-slate-400">←</button><h2 className="font-bold text-white">명령어 편집</h2><span className="w-5" /></header>
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
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="flex h-[72dvh] w-full max-w-app flex-col rounded-t-3xl bg-bg shadow-2xl">
        <header className="flex items-center justify-between px-4 pb-2 pt-4"><div><h2 className="text-lg font-bold text-white">명령어</h2><p className="text-xs text-slate-500">메뉴에서 선택해야 명령어가 활성화됩니다.</p></div><button onClick={onClose} className="p-2 text-xl text-slate-400">×</button></header>
        <div className="flex items-center border-b border-surface2 px-3">
          {(['all', 'mine', 'hub'] as Tab[]).map((value) => <button key={value} onClick={() => { setTab(value); setQuery(''); setSearchOpen(false); }} className={`border-b-2 px-3 py-3 text-sm ${tab === value ? 'border-brand font-semibold text-white' : 'border-transparent text-slate-500'}`}>{value === 'all' ? '전체' : value === 'mine' ? '내 명령어' : '명령어 허브'}</button>)}
          {tab === 'hub' && <button aria-label="명령어 검색" onClick={() => setSearchOpen(true)} className="ml-auto p-2 text-lg text-slate-400">⌕</button>}
        </div>
        {tab === 'hub' && searchOpen && <div className="border-b border-surface2 p-3"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="이름, 설명, 작성자 검색" className="w-full rounded-xl bg-surface px-4 py-2.5 text-sm outline-none" /></div>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">표시할 명령어가 없습니다.</p> : visible.map((command) => {
            const mine = command.owner_id === userId;
            return <div key={command.id} className="relative flex gap-3 border-b border-surface2/70 px-4 py-3">
              <button onClick={() => { onSelect(command); onClose(); }} className="min-w-0 flex-1 text-left">
                <p className="truncate font-semibold text-white"><span className="text-brand">/</span>{command.name} {mine && <span className="ml-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-400">나</span>} {command.is_published && <span className="ml-1 rounded bg-blue-400/15 px-1.5 py-0.5 text-[10px] text-blue-400">허브</span>}</p>
                <p className="mt-1 truncate text-xs text-slate-400">{command.description || '설명 없음'}</p>
                {command.is_published && <p className="mt-1 text-[11px] text-slate-500">올린 사람 · {mine ? '나' : authors[command.owner_id] ?? '사용자'}</p>}
              </button>
              <button aria-label="명령어 메뉴" onClick={() => setOpenMenu(openMenu === command.id ? null : command.id)} className="self-start px-2 text-xl text-slate-500">⋯</button>
              {openMenu === command.id && <div className="absolute right-4 top-10 z-10 min-w-40 overflow-hidden rounded-xl border border-surface2 bg-surface shadow-xl">
                {mine ? <><button onClick={() => beginEdit(command)} className="block w-full px-4 py-2.5 text-left text-sm">명령어 수정</button><button onClick={() => void publish(command, !command.is_published)} className="block w-full px-4 py-2.5 text-left text-sm">{command.is_published ? '허브에서 비공개' : '전체 공개'}</button><button onClick={() => void remove(command)} className="block w-full px-4 py-2.5 text-left text-sm text-red-400">삭제</button></> : <button onClick={() => void copy(command)} className="block w-full px-4 py-2.5 text-left text-sm">내 명령어로 복사</button>}
              </div>}
            </div>;
          })}
        </div>
        <button onClick={() => beginEdit()} className="m-3 rounded-xl border border-brand/40 py-3 text-sm font-semibold text-brand">＋ 명령어 추가</button>
      </section>
    </div>
  );
}
