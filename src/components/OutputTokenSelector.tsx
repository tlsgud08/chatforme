export const OUTPUT_TOKEN_OPTIONS = [3000, 5000, 8000, null] as const;

export function normalizeOutputTokens(value: number | null): number | null {
  if (value === null) return null;
  return OUTPUT_TOKEN_OPTIONS.slice(0, -1).reduce<number>((closest, option) =>
    Math.abs(option! - value) < Math.abs(closest - value) ? option! : closest,
  3000);
}

interface Props {
  value: number | null;
  onChange: (value: number | null) => void;
  label: string;
}

export default function OutputTokenSelector({ value, onChange, label }: Props) {
  const normalized = normalizeOutputTokens(value);
  const selectedIndex = OUTPUT_TOKEN_OPTIONS.findIndex((option) => option === normalized);

  return (
    <div>
      <label className="mb-2 block text-xs text-slate-400">{label}</label>
      <input
        type="range"
        min={0}
        max={OUTPUT_TOKEN_OPTIONS.length - 1}
        step={1}
        value={selectedIndex}
        onChange={(event) => onChange(OUTPUT_TOKEN_OPTIONS[Number(event.target.value)])}
        className="w-full"
        aria-valuetext={normalized === null ? '무제한' : `${normalized} 토큰`}
      />
      <div className="mt-1 flex justify-between text-xs font-semibold text-slate-400" aria-hidden="true">
        {OUTPUT_TOKEN_OPTIONS.map((option) => <span key={option ?? 'unlimited'}>{option ?? '무제한'}</span>)}
      </div>
    </div>
  );
}
