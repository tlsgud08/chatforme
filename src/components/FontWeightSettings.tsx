import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { applyFontWeights, DEFAULT_FONT_WEIGHTS, normalizeFontWeights, type FontWeights } from '@/lib/fontWeights';

export default function FontWeightSettings() {
  const { user } = useAuth();
  const [weights, setWeights] = useState(() => normalizeFontWeights(user?.user_metadata?.inuchat_font_weights));
  const [draft, setDraft] = useState(() => ({ normal: String(weights.normal), bold: String(weights.bold) }));
  const current = useRef(weights);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const version = useRef(0);
  useEffect(() => {
    const next = normalizeFontWeights(user?.user_metadata?.inuchat_font_weights);
    current.current = next; setWeights(next); setDraft({ normal: String(next.normal), bold: String(next.bold) });
  }, [user?.id]);
  useEffect(() => {
    const refresh = (event: Event) => { const next = normalizeFontWeights((event as CustomEvent).detail); current.current = next; setWeights(next); setDraft({ normal: String(next.normal), bold: String(next.bold) }); };
    window.addEventListener('inuchat:font-weights-refreshed', refresh);
    return () => window.removeEventListener('inuchat:font-weights-refreshed', refresh);
  }, []);
  function change(next: FontWeights) {
    current.current = next; setWeights(next); setDraft({ normal: String(next.normal), bold: String(next.bold) }); applyFontWeights(next);
  }
  function save(next: FontWeights) {
    change(next);
    const update = ++version.current;
    queue.current = queue.current.then(async () => {
      const { error } = await supabase.auth.updateUser({ data: { inuchat_font_weights: next } });
      if (error) {
        showToast('글꼴 굵기 저장 실패: ' + error.message);
        if (update === version.current) {
          const { data } = await supabase.auth.getUser();
          change(normalizeFontWeights(data.user?.user_metadata?.inuchat_font_weights));
        }
      }
    });
  }
  function commitInput(key: keyof FontWeights) {
    const n = Number(draft[key]);
    if (!draft[key].trim() || !Number.isInteger(n) || n < 1 || n > 1000) {
      showToast('굵기는 1부터 1000까지 입력해 주세요.');
      setDraft(value => ({ ...value, [key]: String(current.current[key]) })); return;
    }
    if (n !== current.current[key]) save({ ...current.current, [key]: n });
    else setDraft(value => ({ ...value, [key]: String(n) }));
  }
  return <div className="flex flex-col gap-3">
    <div><strong className="text-sm text-white">글꼴 굵기</strong><p className="text-xs text-slate-400 mt-1">숫자는 1~1000까지 직접 입력할 수 있어요. 글꼴에 따라 중간 굵기가 같게 보일 수 있어요.</p></div>
    {(['normal', 'bold'] as const).map(key => {
      const min = key === 'normal' ? 300 : 400, max = key === 'normal' ? 700 : 900;
      return <div key={key}>
        <label className="flex items-center justify-between gap-2 text-sm text-white">{key === 'normal' ? '일반 글자' : '볼드 글자'}
          <input aria-label={key === 'normal' ? '일반 글자 굵기' : '볼드 글자 굵기'} type="number" min="1" max="1000" step="1" value={draft[key]} onChange={e => setDraft(v => ({...v, [key]: e.target.value}))} onBlur={() => commitInput(key)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} className="w-20 rounded bg-surface2 px-2 py-1 text-right" />
        </label>
        <input aria-label={key === 'normal' ? '일반 글자 굵기 조절' : '볼드 글자 굵기 조절'} type="range" min={min} max={max} step="10" value={Math.max(min, Math.min(max, weights[key]))} onChange={e => change({...current.current, [key]: Number(e.currentTarget.value)})} onPointerUp={() => save(current.current)} onKeyUp={() => save(current.current)} onPointerCancel={() => save(current.current)} className="w-full" />
        <div className="flex justify-between text-xs text-slate-400"><span>{min}</span><span>{max}</span></div>
      </div>;
    })}
    <button type="button" className="self-start rounded-lg bg-surface2 px-3 py-2 text-xs text-brand" onClick={() => save(DEFAULT_FONT_WEIGHTS)}>굵기 기본값 되돌리기</button>
  </div>;
}
