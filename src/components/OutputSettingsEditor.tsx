import { useEffect, useState } from 'react';
import OutputTokenSelector from './OutputTokenSelector';
import type { ReasoningSelection, SamplingSettings } from '@/lib/llm/types';

export interface OutputSettingsValue extends SamplingSettings {
  outputTokens: number | null;
  reasoning: ReasoningSelection;
}

interface Props {
  value: OutputSettingsValue;
  onChange: (value: OutputSettingsValue) => void;
  tokenLabel: string;
}

const REASONING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
const REASONING_LABELS = ['Off', '낮음', '중간', '높음'];
const TEMPERATURE_RANGE = { min: 0.8, max: 1.2 } as const;
const FREQUENCY_PENALTY_RANGE = { min: 0, max: 0.5 } as const;

export default function OutputSettingsEditor({ value, onChange, tokenLabel }: Props) {
  const reasoningIndex = Math.max(0, REASONING_LEVELS.indexOf((value.reasoning.effort ?? 'medium') as typeof REASONING_LEVELS[number]));
  const update = (patch: Partial<OutputSettingsValue>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-5">
      <ParameterRow
        title="추론"
        description="Off는 추론을 명시적으로 끄며, 전송 해제는 파라미터 자체를 보내지 않습니다."
        checked={value.reasoning.send !== false}
        onChecked={(send) => update({ reasoning: { ...value.reasoning, send } })}
      >
        <input aria-label="추론 수준" type="range" min={0} max={3} step={1} value={reasoningIndex} onChange={(e) => update({ reasoning: { send: value.reasoning.send !== false, effort: REASONING_LEVELS[Number(e.target.value)] } })} className="w-full" />
        <div className="mt-1 flex justify-between text-xs font-semibold text-slate-400" aria-hidden="true">
          {REASONING_LABELS.map((label) => <span key={label}>{label}</span>)}
        </div>
      </ParameterRow>

      <OutputTokenSelector label={tokenLabel} value={value.outputTokens} onChange={(outputTokens) => update({ outputTokens })} />

      <ParameterRow
        title="Temperature"
        description="낮을수록 일관되고, 높을수록 다양한 답변을 만듭니다."
        checked={value.temperatureSend}
        onChecked={(temperatureSend) => update({ temperatureSend })}
      >
        <NumberParameterControl
          label="Temperature"
          value={value.temperature}
          {...TEMPERATURE_RANGE}
          onChange={(temperature) => update({ temperature })}
        />
      </ParameterRow>

      <ParameterRow
        title="Frequency penalty"
        description="높을수록 이미 사용한 표현의 반복을 줄입니다."
        checked={value.frequencyPenaltySend}
        onChecked={(frequencyPenaltySend) => update({ frequencyPenaltySend })}
      >
        <NumberParameterControl
          label="Frequency penalty"
          value={value.frequencyPenalty}
          {...FREQUENCY_PENALTY_RANGE}
          onChange={(frequencyPenalty) => update({ frequencyPenalty })}
        />
      </ParameterRow>
    </div>
  );
}

function NumberParameterControl({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const boundedValue = Math.min(max, Math.max(min, value));
  const setBoundedValue = (nextValue: number) => onChange(Math.min(max, Math.max(min, nextValue)));
  const [draft, setDraft] = useState(String(boundedValue));

  useEffect(() => setDraft(String(boundedValue)), [boundedValue]);

  const commitDraft = () => {
    const nextValue = Number(draft);
    if (!Number.isFinite(nextValue)) {
      setDraft(String(boundedValue));
      return;
    }
    const nextBoundedValue = Math.min(max, Math.max(min, nextValue));
    setDraft(String(nextBoundedValue));
    onChange(nextBoundedValue);
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-3">
      <div>
        <input
          aria-label={`${label} 슬라이더`}
          type="range"
          min={min}
          max={max}
          step={0.05}
          value={boundedValue}
          onChange={(e) => {
            const nextValue = Number(e.target.value);
            setDraft(e.target.value);
            setBoundedValue(nextValue);
          }}
          className="w-full"
        />
        <Scale left={String(min)} center={boundedValue.toFixed(2)} right={String(max)} />
      </div>
      <input
        aria-label={`${label} 직접 입력`}
        type="number"
        min={min}
        max={max}
        step="any"
        value={draft}
        onChange={(e) => {
          const nextDraft = e.target.value;
          const nextValue = e.target.valueAsNumber;
          setDraft(nextDraft);
          if (Number.isFinite(nextValue) && nextValue >= min && nextValue <= max) onChange(nextValue);
        }}
        onBlur={commitDraft}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-right text-sm text-slate-100 outline-none focus:border-brand"
      />
    </div>
  );
}

function ParameterRow({ title, description, checked, onChecked, children }: { title: string; description: string; checked: boolean; onChecked: (checked: boolean) => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <label className={`text-xs font-semibold text-slate-300 transition-opacity ${checked ? '' : 'opacity-40'}`}>{title}</label>
        <label className="flex items-center gap-1.5 text-xs text-slate-400"><input type="checkbox" checked={checked} onChange={(e) => onChecked(e.target.checked)} /> 전송</label>
      </div>
      <div className={`transition-opacity ${checked ? '' : 'opacity-35'}`}>
        <p className="mb-2 text-[11px] text-slate-500">{description}</p>
        {children}
      </div>
    </div>
  );
}

function Scale({ left, center, right }: { left: string; center: string; right: string }) {
  return <div className="mt-1 grid grid-cols-3 text-xs font-semibold text-slate-400"><span>{left}</span><span className="text-center text-brand">{center}</span><span className="text-right">{right}</span></div>;
}
