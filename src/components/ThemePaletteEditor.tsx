import { useId, useState } from 'react';
import { DEFAULT_DARK, DEFAULT_LIGHT, normalizeThemeHex, parseThemeColorList, secondaryTextStyles, type ThemePalette, type ThemeVariant } from '@/lib/theme';
import './ThemePaletteEditor.css';

const HEX = /^#[0-9a-f]{6}$/i;
type ColorKey='accent'|'accentText'|'main'|'mainText'|'secondaryText';
const colorLabels: { key: ColorKey; name: string }[] = [
  { key: 'accent', name: '강조색' },
  { key: 'accentText', name: '강조색 글자' },
  { key: 'main', name: '메인색' },
  { key: 'mainText', name: '메인색 글자' },
  { key: 'secondaryText', name: '보조 텍스트' },
];

function PaletteFields({ palette, defaults, onChange }: {
  palette: ThemePalette;
  defaults: ThemePalette;
  onChange: (palette: ThemePalette) => void;
}) {
  const id = useId();
  const colorValue=(key:ColorKey)=>key==='secondaryText'?palette.secondaryText??palette.mainText:palette[key];
  const defaultValue=(key:ColorKey)=>key==='secondaryText'?defaults.mainText:defaults[key];
  // Keep partial HEX input editable without clearing the preview's last valid color.
  const [lastValid, setLastValid] = useState(() => Object.fromEntries(
    colorLabels.map(({ key }) => [key, HEX.test(colorValue(key)) ? colorValue(key) : defaultValue(key)]),
  ) as Record<ColorKey,string>);
  const [bulkInput,setBulkInput]=useState('');
  const [bulkStatus,setBulkStatus]=useState<'empty'|'invalid'|'applied'>('empty');
  const preview = { ...lastValid };
  for (const { key } of colorLabels) {
    if (HEX.test(colorValue(key))) preview[key] = colorValue(key);
  }
  function change(key: ColorKey, value: string) {
    setLastValid(preview);
    onChange({ ...palette, [key]: normalizeThemeHex(value) });
  }
  function changeBulk(value:string){
    setBulkInput(value);
    const parsed=parseThemeColorList(value,palette);
    if(!parsed){setBulkStatus(value.trim()?'invalid':'empty');return;}
    setLastValid(Object.fromEntries(colorLabels.map(({key})=>[key,parsed[key]])) as Record<ColorKey,string>);
    setBulkStatus('applied');
    onChange(parsed);
  }
  const secondary=secondaryTextStyles({...palette,...preview});
  return <>
    <details className="theme-palette-bulk">
      <summary>색상 5개 한 번에 입력</summary>
      <label htmlFor={`${id}-bulk`}>강조색;강조색 글자;메인색;메인색 글자;보조 텍스트</label>
      <textarea id={`${id}-bulk`} aria-label="색상 5개 일괄 입력" rows={3} spellCheck={false}
        autoComplete="off" value={bulkInput} onChange={e=>changeBulk(e.target.value)}
        placeholder="#ff4081;#ffffff;#202828;#e5ef58;#64d8df"
        aria-invalid={bulkStatus==='invalid'} aria-describedby={`${id}-bulk-help`}/>
      <p id={`${id}-bulk-help`} className="theme-secondary-help">세미콜론(;)으로 구분하며 #은 생략할 수 있습니다. 올바른 색상 5개를 입력하면 자동으로 적용됩니다.</p>
      {bulkStatus!=='empty'&&<p role="status" className="theme-secondary-help">{bulkStatus==='applied'?'색상 5개를 적용했습니다.':'6자리 HEX 색상 5개를 순서대로 입력해 주세요. 기존 색상은 유지됩니다.'}</p>}
    </details>
    <div className="theme-palette-fields">
      {colorLabels.map(({ key, name }) => {
        const invalid = !HEX.test(colorValue(key));
        return <div key={key} className="theme-palette-row">
          <label htmlFor={`${id}-${key}`}>{name}</label>
          <div className="theme-palette-inputs">
            <input type="color" aria-label={`${name} 선택`} value={preview[key]}
              onChange={e => change(key, e.target.value)} className="theme-palette-swatch" />
            <input id={`${id}-${key}`} aria-label={`${name} HEX`} aria-invalid={invalid}
              aria-describedby={invalid ? `${id}-error` : undefined}
              type="text" maxLength={7} spellCheck={false} autoComplete="off"
              value={colorValue(key)} onChange={e => change(key, e.target.value)}
              className="theme-palette-hex" />
          </div>
        </div>;
      })}
    </div>
    <label className="theme-palette-heading theme-secondary-toggle">
      <input type="checkbox" checked={palette.softenSecondaryText!==false} onChange={e=>onChange({...palette,softenSecondaryText:e.target.checked})}/>
      보조 텍스트 연하게 표시
    </label>
    <label className="theme-opacity-control" htmlFor={`${id}-opacity`}>
      <span>보조 텍스트 불투명도</span>
      <output htmlFor={`${id}-opacity`}>{palette.secondaryTextOpacity??65}%</output>
      <input id={`${id}-opacity`} aria-label="보조 텍스트 불투명도" type="range" min={0} max={100} step={1}
        value={palette.secondaryTextOpacity??65} disabled={palette.softenSecondaryText===false}
        onChange={e=>onChange({...palette,secondaryTextOpacity:Number(e.target.value)})}/>
    </label>
    <p className="theme-secondary-help">기본값은 65%입니다. 연하게 표시를 끄면 지정한 색을 100% 불투명도로 표시합니다.</p>
    {colorLabels.some(({ key }) => !HEX.test(colorValue(key))) &&
      <p id={`${id}-error`} className="theme-palette-error">6자리 HEX 코드를 입력해 주세요. #은 자동으로 추가되며, 미리보기에는 마지막 유효한 색상이 표시됩니다.</p>}
    <section aria-label="테마 미리보기" className="theme-palette-preview"
      style={{ backgroundColor: preview.main, color: preview.mainText }}>
      <h4>테마 미리보기</h4>
      <p>메인 배경과 글자색입니다.</p>
      <p style={{color:secondary.color,opacity:secondary.chatOpacity}}>채팅의 *연하게 표시한 텍스트* 미리보기</p>
      <button type="button" className="theme-palette-preview-button"
        style={{ backgroundColor: preview.accent, color: preview.accentText }}>강조색 버튼</button>
    </section>
  </>;
}

export default function ThemePaletteEditor({ variant, palette, onChange }: {
  variant: ThemeVariant | 'single';
  palette: ThemePalette | null;
  onChange: (palette: ThemePalette) => void;
}) {
  const defaults = variant === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT;
  return <section className="theme-palette-editor">
    <div className="theme-palette-heading">
      {variant === 'single' ? '🎨 테마 색상' : variant === 'dark' ? '🌙 다크 버전' : '☀️ 라이트 버전'}
    </div>
    {palette && <PaletteFields palette={palette} defaults={defaults} onChange={onChange} />}
  </section>;
}
