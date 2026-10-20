import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { bothVariants, loadTheme, requestThemeRefresh, type SavedTheme, type ThemeVariant } from '@/lib/theme';
import ThemeMenu from './ThemeMenu';
import InterfaceIcon from './InterfaceIcon';

type Mode = 'dark' | 'light' | 'custom';
type Pref = {
  prefer_work_theme: boolean;
  preferred_theme_mode: Mode | null;
  preferred_theme_id: string | null;
  preferred_theme_variant: ThemeVariant;
};

export default function ThemePreferences({ userId }: { userId: string }) {
  const [pref, setPref] = useState<Pref>({
    prefer_work_theme: true,
    preferred_theme_mode: null,
    preferred_theme_id: null,
    preferred_theme_variant: 'light',
  });
  const [chosen, setChosen] = useState<SavedTheme | null>(null);
  const [picker, setPicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const latestUpdate = useRef(0);
  const currentPref = useRef(pref);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let live = true;
    async function refresh() {
      // Ignore background fetches started before a newer local preference edit.
      const startUpdate = latestUpdate.current;
      const { data, error } = await supabase.from('profiles')
        .select('prefer_work_theme,preferred_theme_mode,preferred_theme_id,preferred_theme_variant')
        .eq('id', userId).single();
      if (!live) return;
      if (error) {
        showToast('테마 설정을 불러오지 못했습니다: ' + error.message);
        setLoading(false);
        return;
      }
      const selectedId = data?.preferred_theme_id;
      const { data: theme } = selectedId
        ? await supabase.from('themes').select('*').eq('id', selectedId).maybeSingle()
        : { data: null };
      if (!live || latestUpdate.current !== startUpdate) return;
      if (data) { currentPref.current = data as Pref; setPref(data as Pref); }
      setChosen((theme as SavedTheme | null) ?? null);
      setLoading(false);
    }
    const reload = () => { void refresh(); };
    void refresh();
    // Reconcile theme edits/deletions and cross-device changes on resume.
    window.addEventListener('inuchat:theme-changed', reload);
    window.addEventListener('focus', reload);
    return () => {
      live = false;
      window.removeEventListener('inuchat:theme-changed', reload);
      window.removeEventListener('focus', reload);
    };
  }, [userId]);

  // Queue overlapping writes. An older network request may not be allowed
  // to overwrite a newer mode/variant selection on another device.
  async function update(patch: Partial<Pref>, theme?: SavedTheme | null): Promise<boolean> {
    const operation = ++latestUpdate.current;
    const previous = currentPref.current;
    const previousTheme = chosen;
    const next = { ...previous, ...patch };
    currentPref.current = next;
    setPref(next);
    if (theme !== undefined) setChosen(theme);

    const pending = saveQueue.current.then(() =>
      supabase.from('profiles').update(patch).eq('id', userId)
    );
    saveQueue.current = pending.then(() => undefined, () => undefined);
    const { error } = await pending;
    if (error) {
      showToast('테마 설정 저장 실패: ' + error.message);
      if (operation === latestUpdate.current) {
        currentPref.current = previous;
        setPref(previous);
        if (theme !== undefined) setChosen(previousTheme);
      }
    }
    if (operation === latestUpdate.current) requestThemeRefresh();
    return !error;
  }

  const currentMode = pref.preferred_theme_mode ?? (loadTheme() === 'dark' ? 'dark' : 'light');

  function changeMode(mode: Mode) {
    if (mode === 'custom') {
      // Selecting the tab and opening its catalog are two different actions.
      // A previously selected custom theme remains selected after dark/light.
      if (!pref.preferred_theme_id) setPicker(true);
      void update({ preferred_theme_mode: 'custom' });
      return;
    }
    setPicker(false);
    // Preserve the previous custom theme and its own variant for next time.
    void update({ preferred_theme_mode: mode });
  }

  return <section className="flex flex-col gap-3">
    <h2 className="font-semibold text-white">화면 테마</h2>
    <p className="text-xs text-slate-500">
      테마 설정은 로그인한 모든 기기에 저장됩니다.
    </p>
    {loading ? <p className="text-sm text-slate-400">불러오는 중…</p> : <>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface p-1.5" role="group" aria-label="기본 테마">
        {(['light', 'dark', 'custom'] as const).map(mode =>
          <button
            key={mode}
            type="button"
            aria-pressed={currentMode === mode}
            onClick={() => changeMode(mode)}
            className={`theme-mode-button rounded-lg px-2 py-2.5 text-xs font-semibold ${currentMode === mode ? 'bg-brand text-white' : 'text-slate-400'}`}
          >
            <InterfaceIcon name={mode === 'dark' ? 'moon' : mode === 'light' ? 'sun' : 'palette'} legacy={mode === 'dark' ? '🌙' : mode === 'light' ? '☀️' : '🎨'} /> {mode === 'dark' ? '다크' : mode === 'light' ? '라이트' : '커스텀'}
          </button>
        )}
      </div>

      {currentMode === 'custom' && <div className="rounded-xl bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-white">{chosen?.name ?? '선택한 테마 없음'}</span>
          <button
            type="button"
            onClick={() => setPicker(value => !value)}
            className="rounded-lg bg-surface2 px-3 py-2 text-xs text-brand"
            aria-expanded={picker}
          >
            {picker ? '목록 닫기' : chosen ? '테마 변경' : '테마 선택'}
          </button>
        </div>
        {!chosen && <p className="mt-2 text-xs text-slate-400">
          테마를 선택하거나 제작하면 지정한 커스텀 색상이 적용됩니다.
        </p>}
        {chosen && !bothVariants(chosen) && <p className="mt-2 text-xs text-slate-400">단일 테마 · 색상은 유지되며, 선호값은 이후 라이트·다크 버전이 있는 테마에 사용됩니다.</p>}
        <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="라이트·다크 선호">
          {(['light', 'dark'] as const).map(variant =>
            <button
              key={variant}
              type="button"
              aria-pressed={pref.preferred_theme_variant === variant}
              onClick={() => void update({ preferred_theme_variant: variant })}
              className={`rounded-lg px-3 py-2 text-xs ${pref.preferred_theme_variant === variant ? 'bg-brand text-white' : 'bg-surface2 text-slate-400'}`}
            >
              <InterfaceIcon name={variant === 'dark' ? 'moon' : 'sun'} legacy={variant === 'dark' ? '🌙' : '☀️'} /> {variant === 'dark' ? '다크' : '라이트'}
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-400">채팅방 유동적 모드의 라이트·다크 선호 설정과 함께 동기화됩니다.</p>
        {picker && userId && <div className="mt-3 overflow-hidden rounded-xl border border-surface2 bg-bg">
          <ThemeMenu
            userId={userId}
            selectedId={pref.preferred_theme_id}
            onClose={() => setPicker(false)}
            onSelect={theme => {
              // Keep the variant independent, including concurrent preference edits.
              void update({
                preferred_theme_mode: 'custom',
                preferred_theme_id: theme.id,
              }, theme).then(ok => { if (ok) setPicker(false); });
            }}
          />
        </div>}
      </div>}

      {userId && <label className="flex items-start justify-between gap-3 rounded-xl bg-surface p-3">
        <span className="flex flex-col gap-1">
          <strong className="text-sm text-white">작품 테마 기본 사용</strong>
          <span className="text-xs text-slate-400">
            채팅방에서 별도로 설정하지 않은 경우 작품 제작자의 기본 테마를 사용합니다.
          </span>
        </span>
        <input
          type="checkbox"
          checked={pref.prefer_work_theme}
          onChange={event => void update({ prefer_work_theme: event.target.checked })}
          className="mt-1"
        />
      </label>}
    </>}
  </section>;
}
