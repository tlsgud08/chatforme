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

export default function OutputSettingsEditor({ value, onChange, tokenLabel }: Props) {
  const reasoningIndex = Math.max(0, REASONING_LEVELS.indexOf((value.reasoning.effort ?? 'medium') as typeof REASONING_LEVELS[number]));
  const update = (patch: Partial<OutputSettingsValue>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-5">
      <ParameterRow
        title="Temperature"
        description="낮을수록 일관되고, 높을수록 다양한 답변을 만듭니다."
        checked={value.temperatureSend}
        onChecked={(temperatureSend) => update({ temperatureSend })}
      >
        <input aria-label="Temperature" type="range" min={0} max={2} step={0.1} value={value.temperature} onChange={(e) => update({ temperature: Number(e.target.value) })} className="w-full" />
        <Scale left="0" center={value.temperature.toFixed(1)} right="2" />
      </ParameterRow>

      <ParameterRow
        title="Frequency penalty"
        description="높을수록 이미 사용한 표현의 반복을 줄입니다."
        checked={value.frequencyPenaltySend}
        onChecked={(frequencyPenaltySend) => update({ frequencyPenaltySend })}
      >
        <input aria-label="Frequency penalty" type="range" min={-2} max={2} step={0.1} value={value.frequencyPenalty} onChange={(e) => update({ frequencyPenalty: Number(e.target.value) })} className="w-full" />
        <Scale left="-2" center={value.frequencyPenalty.toFixed(1)} right="2" />
      </ParameterRow>

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
    </div>
  );
}

function ParameterRow({ title, description, checked, onChecked, children }: { title: string; description: string; checked: boolean; onChecked: (checked: boolean) => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <label className="text-xs font-semibold text-slate-300">{title}</label>
        <label className="flex items-center gap-1.5 text-xs text-slate-400"><input type="checkbox" checked={checked} onChange={(e) => onChecked(e.target.checked)} /> 전송</label>
      </div>
      <p className="mb-2 text-[11px] text-slate-500">{description}</p>
      {children}
    </div>
  );
}

function Scale({ left, center, right }: { left: string; center: string; right: string }) {
  return <div className="mt-1 grid grid-cols-3 text-xs font-semibold text-slate-400"><span>{left}</span><span className="text-center text-brand">{center}</span><span className="text-right">{right}</span></div>;
}
