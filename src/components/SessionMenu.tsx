import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Profile, Session } from '@/types/db';

const MAX_NOTE = 2000;

interface Props {
  session: Session;
  profile: Profile | null;
  onClose: () => void;
  onUpdate: (patch: Partial<Session>) => void;
}

// 채팅방 측면 메뉴: 유저 노트 + 출력량 (페르소나 교체는 Phase 2에서 추가)
export default function SessionMenu({ session, profile, onClose, onUpdate }: Props) {
  const [note, setNote] = useState(session.user_note);
  const [override, setOverride] = useState<number | null>(session.output_tokens_override);
  const [savedMsg, setSavedMsg] = useState('');

  async function saveNote() {
    const trimmed = note.slice(0, MAX_NOTE);
    await supabase.from('sessions').update({ user_note: trimmed }).eq('id', session.id);
    onUpdate({ user_note: trimmed });
    flash('유저 노트를 저장했습니다.');
  }

  async function saveOverride(value: number | null) {
    setOverride(value);
    await supabase.from('sessions').update({ output_tokens_override: value }).eq('id', session.id);
    onUpdate({ output_tokens_override: value });
  }

  function flash(m: string) {
    setSavedMsg(m);
    setTimeout(() => setSavedMsg(''), 1500);
  }

  const effectiveOutput = override ?? profile?.default_output_tokens ?? 1024;

  return (
    <div className="fixed inset-0 z-20 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative flex h-full w-[85%] max-w-[360px] flex-col gap-5 overflow-y-auto bg-bg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <h2 className="font-semibold text-white">세션 메뉴</h2>
          <button onClick={onClose} className="ml-auto text-slate-400">
            ✕
          </button>
        </div>

        {/* 출력량 */}
        <section>
          <label className="mb-1 block text-xs text-slate-400">
            이 세션 출력량 (최대 출력 토큰):{' '}
            {effectiveOutput === null ? '무제한' : effectiveOutput}
            {override === null && ' (기본값)'}
          </label>
          <input
            type="range"
            min={256}
            max={4096}
            step={128}
            value={typeof effectiveOutput === 'number' ? effectiveOutput : 4096}
            onChange={(e) => saveOverride(Number(e.target.value))}
            className="w-full"
          />
          {override !== null && (
            <button onClick={() => saveOverride(null)} className="mt-1 text-xs text-slate-400 underline">
              기본값으로 되돌리기
            </button>
          )}
        </section>

        {/* 유저 노트 */}
        <section>
          <label className="mb-1 block text-xs text-slate-400">
            유저 노트 ({note.length}/{MAX_NOTE})
          </label>
          <p className="mb-2 text-[11px] text-slate-500">
            이 세션에서만 AI에게 전달되는 메모입니다. 언제든 편집할 수 있습니다.
          </p>
          <textarea
            value={note}
            maxLength={MAX_NOTE}
            onChange={(e) => setNote(e.target.value)}
            rows={8}
            placeholder="예: 내 캐릭터는 항상 존댓말을 쓴다. 현재 목표는…"
            className="w-full resize-none rounded-lg bg-surface px-3 py-2.5 text-sm outline-none"
          />
          <button
            onClick={saveNote}
            className="mt-2 w-full rounded-lg bg-brand py-2 text-sm font-semibold text-white"
          >
            유저 노트 저장
          </button>
        </section>

        {/* 페르소나 (Phase 2) */}
        <section>
          <h3 className="mb-1 text-sm font-semibold text-slate-300">페르소나</h3>
          <p className="text-xs text-slate-500">페르소나 교체는 Phase 2에서 추가됩니다.</p>
        </section>

        {savedMsg && <p className="text-center text-xs text-brand">{savedMsg}</p>}
      </div>
    </div>
  );
}
