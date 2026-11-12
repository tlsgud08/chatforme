import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { applyChatFontSize, normalizeChatFontSize } from '@/lib/chatFontSize';

const DEFAULT_SIZE = 14;
export default function ChatFontSizeSettings() {
  const { user } = useAuth();
  const [size, setSize] = useState<number | null>(() => normalizeChatFontSize(user?.user_metadata?.inuchat_chat_font_size));
  const [draft, setDraft] = useState(() => String(size ?? DEFAULT_SIZE));
  const current = useRef(size);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const version = useRef(0);
  const userId = useRef(user?.id);
  userId.current = user?.id;

  function change(next: number | null) {
    current.current = next;
    setSize(next);
    setDraft(String(next ?? DEFAULT_SIZE));
    applyChatFontSize(next);
  }
  useEffect(() => {
    const next = normalizeChatFontSize(user?.user_metadata?.inuchat_chat_font_size);
    current.current = next; setSize(next); setDraft(String(next ?? DEFAULT_SIZE));
  }, [user?.id]);
  useEffect(() => {
    let active = true;
    const initialVersion = version.current;
    if (user?.id) void supabase.auth.getUser().then(({ data, error }) => {
      if (active && !error && data.user?.id === user.id && version.current === initialVersion) change(normalizeChatFontSize(data.user.user_metadata?.inuchat_chat_font_size));
    });
    return () => { active = false; };
  }, [user?.id]);
  useEffect(() => {
    const refresh = (event: Event) => change(normalizeChatFontSize((event as CustomEvent).detail));
    window.addEventListener('inuchat:chat-font-size-refreshed', refresh);
    return () => window.removeEventListener('inuchat:chat-font-size-refreshed', refresh);
  }, []);
  function save(next: number | null) {
    change(next);
    const operation = ++version.current;
    const owner = user?.id;
    queue.current = queue.current.then(async () => {
      if (!owner || userId.current !== owner) return;
      const { error } = await supabase.auth.updateUser({ data: { inuchat_chat_font_size: next } });
      if (error && userId.current === owner) {
        showToast('글꼴 크기 저장 실패: ' + error.message);
        if (operation === version.current) {
          const { data, error: readError } = await supabase.auth.getUser();
          if (!readError && data.user?.id === owner && operation === version.current) change(normalizeChatFontSize(data.user.user_metadata?.inuchat_chat_font_size));
        }
      }
    }).catch(() => { if (userId.current === owner) showToast('글꼴 크기를 저장하지 못했습니다.'); });
  }
  function commitInput() {
    const value = Number(draft);
    if (!draft.trim() || !Number.isInteger(value) || value < 1 || value > 96) {
      showToast('글꼴 크기는 1부터 96px까지 입력해 주세요.');
      setDraft(String(current.current ?? DEFAULT_SIZE));
      return;
    }
    if ((current.current ?? DEFAULT_SIZE) !== value) save(value); else setDraft(String(value));
  }
  return <div className="flex flex-col gap-3 rounded-xl bg-surface p-3">
    <div><strong className="text-sm text-white">채팅 글꼴 크기</strong><p className="mt-1 text-xs text-slate-400">채팅과 상태창 본문에 적용됩니다. 숫자는 1~96px까지 직접 입력할 수 있어요.</p></div>
    <label className="flex items-center justify-between gap-2 text-sm text-white">글꼴 크기 (px)
      <input aria-label="채팅 글꼴 크기" type="number" min="1" max="96" step="1" value={draft} onChange={event => setDraft(event.currentTarget.value)} onBlur={commitInput} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="w-20 rounded bg-surface2 px-2 py-1 text-right" />
    </label>
    <input aria-label="채팅 글꼴 크기 조절" type="range" min="12" max="24" step="1" value={Math.max(12, Math.min(24, size ?? DEFAULT_SIZE))} onChange={event => change(Number(event.currentTarget.value))} onPointerUp={() => save(current.current)} onPointerCancel={() => save(current.current)} onKeyUp={() => save(current.current)} className="w-full" />
    <div className="flex justify-between text-xs text-slate-400"><span>12px</span><span>24px</span></div>
    <div className="rounded-lg bg-bg p-3 text-white" aria-label="글꼴 크기 미리보기" style={{fontSize: `${size ?? DEFAULT_SIZE}px`, fontWeight: 'var(--chat-font-weight, 400)'}}>오늘은 어떤 이야기가 펼쳐질까요? <strong style={{fontWeight: 'var(--chat-bold-weight, 700)'}}>중요한 내용은 이렇게 강조돼요.</strong></div>
    <button type="button" className="self-start rounded-lg bg-surface2 px-3 py-2 text-xs text-brand" onClick={() => save(null)}>기본값 되돌리기</button>
  </div>;
}
