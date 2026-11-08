import { CODE_BLOCK_STYLES, normalizeCodeBlockStyle, type CodeBlockStyle } from '@/lib/codeBlockStyles';

export default function CodeBlockStyleSelect({ value, onChange, disabled = false, label = '상태창 유형' }: {
  value: CodeBlockStyle;
  onChange: (style: CodeBlockStyle) => void;
  disabled?: boolean;
  label?: string;
}) {
  return <label className="flex flex-col gap-2 text-xs text-slate-400">
    <span>{label}</span>
    <select aria-label={label} value={value} disabled={disabled}
      onChange={event => onChange(normalizeCodeBlockStyle(event.currentTarget.value))}
      className="w-full rounded-lg bg-surface p-3 text-sm text-white disabled:opacity-50">
      {CODE_BLOCK_STYLES.map(style => <option key={style.value} value={style.value}>{style.label}</option>)}
    </select>
  </label>;
}
