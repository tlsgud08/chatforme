import { useId, useState } from 'react';
import { DEFAULT_DARK, DEFAULT_LIGHT, type ThemePalette, type ThemeVariant } from '@/lib/theme';
import './ThemePaletteEditor.css';

const HEX = /^#[0-9a-f]{6}$/i;
const colorLabels: { key: keyof ThemePalette; name: string }[] = [
  { key: 'accent', name: '강조색' },
  { key: 'accentText', name: '강조색 글자' },
  { key: 'main', name: '메인색' },
  { key: 'mainText', name: '메인색 글자' },
];

function PaletteFields({ palette, defaults, onChange }: {
  palette: ThemePalette;
  defaults: ThemePalette;
  onChange: (palette: ThemePalette) => void;
}) {
  const id = useId();
  // Keep partial HEX input editable without clearing the preview's last valid color.
  const [lastValid, setLastValid] = useState(() => Object.fromEntries(
    colorLabels.map(({ key }) => [key, HEX.test(palette[key]) ? palette[key] : defaults[key]]),
  ) as ThemePalette);
  const preview = { ...lastValid };
  for (const { key } of colorLabels) {
    if (HEX.test(palette[key])) preview[key] = palette[key];
  }
  function change(key: keyof ThemePalette, value: string) {
    setLastValid(preview);
    onChange({ ...palette, [key]: value });
  }
  return <>
    <div className="theme-palette-fields">
      {colorLabels.map(({ key, name }) => {
        const invalid = !HEX.test(palette[key]);
        return <div key={key} className="theme-palette-row">
          <label htmlFor={`${id}-${key}`}>{name}</label>
          <div className="theme-palette-inputs">
            <input type="color" aria-label={`${name} 선택`} value={preview[key]}
              onChange={e => change(key, e.target.value)} className="theme-palette-swatch" />
            <input id={`${id}-${key}`} aria-label={`${name} HEX`} aria-invalid={invalid}
              aria-describedby={invalid ? `${id}-error` : undefined}
              type="text" maxLength={7} spellCheck={false} autoComplete="off"
              value={palette[key]} onChange={e => change(key, e.target.value)}
              className="theme-palette-hex" />
          </div>
        </div>;
      })}
    </div>
    {colorLabels.some(({ key }) => !HEX.test(palette[key])) &&
      <p id={`${id}-error`} className="theme-palette-error"># 뒤에 6자리 HEX 코드를 입력해 주세요. 미리보기에는 마지막 유효한 색상이 표시됩니다.</p>}
    <section aria-label="테마 미리보기" className="theme-palette-preview"
      style={{ backgroundColor: preview.main, color: preview.mainText }}>
      <h4>테마 미리보기</h4>
      <p>메인 배경과 글자색입니다.</p>
      <button type="button" className="theme-palette-preview-button"
        style={{ backgroundColor: preview.accent, color: preview.accentText }}>강조색 버튼</button>
    </section>
  </>;
}

export default function ThemePaletteEditor({ variant, palette, onChange, onDisable }: {
  variant: ThemeVariant;
  palette: ThemePalette | null;
  onChange: (palette: ThemePalette) => void;
  onDisable: () => void;
}) {
  const defaults = variant === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT;
  return <section className="theme-palette-editor">
    <label className="theme-palette-heading">
      <input type="checkbox" checked={!!palette}
        onChange={e => e.target.checked ? onChange({ ...defaults }) : onDisable()} />
      {variant === 'dark' ? '🌙 다크 버전' : '☀️ 라이트 버전'}
    </label>
    {palette && <PaletteFields palette={palette} defaults={defaults} onChange={onChange} />}
  </section>;
}
