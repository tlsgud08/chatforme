import { useEffect, useState } from 'react';
import type { Provider } from '@/types/db';
import { capabilitiesFor, defaultReasoningFor, EFFORT_LABELS } from '@/lib/llm/modelCapabilities';
import { isModelVerified } from '@/lib/llm/modelDiscovery';
import type { ReasoningSelection } from '@/lib/llm/types';
import { loadCustomModels, modelsFor, removeCustomModel, saveCustomModel } from '@/lib/modelPreferences';

interface Props {
  provider: Provider;
  model: string;
  reasoning: ReasoningSelection;
  onModelChange: (model: string) => void;
  onReasoningChange: (reasoning: ReasoningSelection) => void;
}

const RELEASE_LABEL = { stable: 'Stable', preview: 'Preview', alias: 'Alias' } as const;
const AVAILABILITY_LABEL = { verified: 'OpenRouter 계정 확인됨', unverified: 'OpenRouter 접근 미확인', unavailable: '사용 불가' } as const;

export default function ModelSelector({ provider, model, reasoning, onModelChange, onReasoningChange }: Props) {
  const [customInput, setCustomInput] = useState('');
  const [revision, setRevision] = useState(0);
  const models = modelsFor(provider);
  const custom = loadCustomModels()[provider];
  const registeredCapability = capabilitiesFor(provider, model);
  const capability = isModelVerified(model)
    ? { ...registeredCapability, availability: 'verified' as const }
    : registeredCapability;

  useEffect(() => {
    const effortValid = !reasoning.effort || capability.supportedEfforts.includes(reasoning.effort);
    if (!effortValid || reasoning.mode) onReasoningChange(defaultReasoningFor(provider, model));
  }, [provider, model, reasoning.effort, reasoning.mode]);

  function selectModel(nextModel: string) {
    onModelChange(nextModel);
    onReasoningChange(defaultReasoningFor(provider, nextModel));
  }

  function addModel() {
    const value = customInput.trim();
    if (!value) return;
    saveCustomModel(provider, value);
    selectModel(value);
    setCustomInput('');
    setRevision((value) => value + 1);
  }

  void revision;
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-slate-400">모델</label>
      <select value={model} onChange={(event) => selectModel(event.target.value)} className="w-full rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none">
        {models.map((item) => {
          const registered = capabilitiesFor(provider, item);
          const info = isModelVerified(item) ? { ...registered, availability: 'verified' as const } : registered;
          return <option key={item} value={item}>{info.displayName} · {item}</option>;
        })}
      </select>

      <div className="rounded-lg border border-surface2 p-2.5 text-[11px] text-slate-400">
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded bg-surface2 px-1.5 py-0.5">{RELEASE_LABEL[capability.release]}</span>
          <span className="rounded bg-surface2 px-1.5 py-0.5">{AVAILABILITY_LABEL[capability.availability]}</span>
          <span>{capability.profile}</span>
        </div>
        <p className="mt-1 break-all">ID: {capability.modelId}</p>
        <p>OpenRouter Chat Completions API</p>
      </div>

      <div className="flex gap-2">
        <input value={customInput} onChange={(event) => setCustomInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } }} placeholder="OpenRouter 모델 ID (배급사/모델)" className="min-w-0 flex-1 rounded-lg bg-surface px-3 py-2.5 text-sm outline-none" />
        <button type="button" onClick={addModel} className="rounded-lg bg-surface2 px-3 text-xs font-semibold text-white">저장</button>
      </div>
      {custom.includes(model) && <button type="button" onClick={() => { removeCustomModel(provider, model); selectModel(modelsFor(provider)[0]); setRevision((value) => value + 1); }} className="self-end text-xs text-red-400">저장한 모델 삭제</button>}

      {capability.supportedEfforts.length > 0 ? (
        <>
          <label className="mt-1 text-xs text-slate-400">Native 추론 수준</label>
          <select value={reasoning.effort ?? capability.defaultEffort} onChange={(event) => onReasoningChange({ ...reasoning, effort: event.target.value })} className="w-full rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none">
            {capability.supportedEfforts.map((effort) => <option key={effort} value={effort}>{EFFORT_LABELS[effort] ?? effort}{effort === capability.defaultEffort ? ' · 기본값' : ''}</option>)}
          </select>
          <p className="text-[11px] text-slate-500">OpenRouter 전송값: reasoning.effort={reasoning.effort ?? capability.defaultEffort}</p>
        </>
      ) : (
        <p className="text-[11px] text-slate-500">이 모델에는 확인되지 않은 추론 옵션을 전송하지 않습니다.</p>
      )}
      {capability.notes?.map((note) => <p key={note} className="text-[11px] text-amber-500">{note}</p>)}
    </div>
  );
}
