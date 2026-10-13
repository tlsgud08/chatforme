import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { ActivePlugin, Plugin, Session } from '@/types/db';
import PluginMenu from './PluginMenu';

interface Props {
  session: Session;
  userId: string;
  busy: boolean;
  onUpdate: (patch: Partial<Session>) => void;
}

export default function SessionPluginSettings({ session, userId, busy, onUpdate }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const lock = useRef(false);
  const plugins = session.active_plugins ?? [];

  async function save(next: ActivePlugin[]) {
    if (busy || lock.current) return;
    lock.current = true;
    setSaving(true);
    setStatus('');
    try {
      const { data, error } = await supabase.from('sessions').update({ active_plugins: next })
        .eq('id', session.id).select('id').single();
      if (error || !data) throw error;
      onUpdate({ active_plugins: next });
      setOpen(false);
      setStatus('저장했습니다. 다음 채팅 요청부터 적용됩니다.');
    } catch {
      setStatus('플러그인 설정을 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  function activate(plugin: Plugin) {
    if (plugins.some((item) => item.id === plugin.id)) return;
    void save([...plugins, { id: plugin.id, name: plugin.name, description: plugin.description, prompt: plugin.prompt }]);
  }

  return <section aria-labelledby="session-plugin-title">
    <h3 id="session-plugin-title" className="mb-2 text-sm font-semibold text-slate-300">플러그인</h3>
    <p className="mb-2 text-[11px] text-slate-500">활성화한 플러그인은 끌 때까지 매 채팅 요청에 포함됩니다.</p>
    <div className="flex flex-col gap-1.5">
      {plugins.map((plugin) => <article key={plugin.id} className="rounded-lg bg-surface px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <h4 className="min-w-0 break-words text-sm font-semibold text-slate-200">{plugin.name}</h4>
          <button type="button" disabled={busy || saving} aria-label={`${plugin.name} 비활성화`}
            onClick={() => void save(plugins.filter((item) => item.id !== plugin.id))}
            className="shrink-0 text-xs text-slate-400 disabled:opacity-50">비활성화</button>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{plugin.description || '설명 없음'}</p>
      </article>)}
      {plugins.length === 0 && <p className="text-xs text-slate-500">활성화된 플러그인이 없습니다.</p>}
    </div>
    <button type="button" disabled={busy || saving} onClick={() => setOpen(true)}
      className="mt-3 w-full rounded-lg border border-brand/40 py-2.5 text-sm font-semibold text-brand disabled:opacity-50">＋ 플러그인 추가</button>
    <p className="mt-2 text-[11px] text-slate-500">활성화 시점의 내용을 사용합니다. 수정한 내용을 적용하려면 껐다가 다시 추가해 주세요.</p>
    <p role="status" className="mt-2 text-xs text-slate-300">{status}</p>
    {open && <PluginMenu userId={userId} onClose={() => setOpen(false)} onSelect={activate}
      activeIds={plugins.map((plugin) => plugin.id)} selecting={busy || saving} />}
  </section>;
}
