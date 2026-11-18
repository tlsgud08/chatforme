import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { type SavedTheme, type ThemeVariant, validPalette } from '@/lib/theme';

interface ThemeChoice {
  id: string | null;
  variant: ThemeVariant;
}

export default function SceneShareThemeSettings() {
  const [themes, setThemes] = useState<Pick<SavedTheme, 'id' | 'name' | 'dark_colors' | 'light_colors'>[]>([]);
  const [selected, setSelected] = useState('dark');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      supabase.from('themes').select('id, name, dark_colors, light_colors').order('name').abortSignal(controller.signal),
      supabase.rpc('get_scene_share_theme').abortSignal(controller.signal),
    ]).then(([catalog, config]) => {
      if (controller.signal.aborted) return;
      if (catalog.error || config.error) {
        setMessage('공유 화면 테마를 불러오지 못했어요.');
        return;
      }
      const choice = config.data as ThemeChoice;
      setThemes(catalog.data ?? []);
      setSelected(choice.id ? choice.id + ':' + choice.variant : choice.variant);
      setReady(true);
    });
    return () => controller.abort();
  }, []);

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    setMessage('');
    const [themeId, themeVariant] = visibleSelected.split(':');
    try {
      const result = await supabase.rpc('set_scene_share_theme', {
        p_theme_id: themeVariant ? themeId : null,
        p_variant: themeVariant ?? themeId,
      });
      setMessage(result.error ? '공유 화면 테마를 저장하지 못했어요.' : '공유 화면 테마를 저장했어요.');
    } catch {
      setMessage('공유 화면 테마를 저장하지 못했어요.');
    } finally {
      setSaving(false);
    }
  }

  const choices = themes.flatMap(theme => (['dark', 'light'] as const)
    .filter(variant => validPalette(variant === 'dark' ? theme.dark_colors : theme.light_colors))
    .map(variant => ({ value: theme.id + ':' + variant, label: theme.name + (variant === 'dark' ? ' · 다크' : ' · 라이트') })));
  const visibleSelected = selected.includes(':') && !choices.some(choice => choice.value === selected) ? 'dark' : selected;

  return <div className="my-4">
    <label className="block text-sm font-medium" htmlFor="shared-scene-theme">공유 채팅방 테마</label>
    <div className="mt-2 flex flex-wrap gap-2">
      <select id="shared-scene-theme" className="min-w-0 flex-1 rounded-lg border border-surface2 bg-surface px-3 py-2 text-sm"
        value={visibleSelected} disabled={!ready || saving} onChange={event => setSelected(event.target.value)}>
        <option value="dark">이누챗 기본 다크</option>
        <option value="light">이누챗 기본 라이트</option>
        {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select>
      <button type="button" className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white" disabled={!ready || saving}
        onClick={() => void save()}>{saving ? '저장 중…' : '테마 저장'}</button>
    </div>
    {message && <p role="status" className="mt-2 text-sm text-slate-400">{message}</p>}
  </div>;
}
