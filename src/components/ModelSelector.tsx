import { useEffect, useState } from 'react';
import type { Provider } from '@/types/db';
import { REASONING_LABELS, reasoningOptions, type ReasoningEffort } from '@/lib/llm/types';
import { loadCustomModels, modelsFor, removeCustomModel, saveCustomModel } from '@/lib/modelPreferences';

interface Props {
  provider: Provider;
  model: string;
  reasoning: ReasoningEffort;
  onModelChange: (model: string) => void;
  onReasoningChange: (reasoning: ReasoningEffort) => void;
}

export default function ModelSelector({ provider, model, reasoning, onModelChange, onReasoningChange }: Props) {
  const [customInput, setCustomInput] = useState('');
  const [revision, setRevision] = useState(0);
  const models = modelsFor(provider);
  const custom = loadCustomModels()[provider];
  const options = reasoningOptions(provider, model);

  useEffect(() => {
    if (!options.includes(reasoning)) onReasoningChange(options[0]);
  }, [model, provider, reasoning]);

  function addModel() {
    const value = customInput.trim();
    if (!value) return;
    saveCustomModel(provider, value);
    onModelChange(value);
    setCustomInput('');
    setRevision((v) => v + 1);
  }

  void revision;
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-slate-400">모델</label>
      <select value={model} onChange={(e) => onModelChange(e.target.value)} className="w-full rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none">
        {models.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <div className="flex gap-2">
        <input
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addModel(); } }}
          placeholder={provider === 'openrouter' ? '배급사/모델 ID 직접 입력' : '모델 ID 직접 입력'}
          className="min-w-0 flex-1 rounded-lg bg-surface px-3 py-2.5 text-sm outline-none"
        />
        <button type="button" onClick={addModel} className="rounded-lg bg-surface2 px-3 text-xs font-semibold text-white">저장</button>
      </div>
      {custom.includes(model) && (
        <button type="button" onClick={() => { removeCustomModel(provider, model); onModelChange(modelsFor(provider)[0]); setRevision((v) => v + 1); }} className="self-end text-xs text-red-400">
          저장한 모델 삭제
        </button>
      )}
      <label className="mt-1 text-xs text-slate-400">사고 수준</label>
      <select value={reasoning} onChange={(e) => onReasoningChange(e.target.value as ReasoningEffort)} className="w-full rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none">
        {options.map((level) => <option key={level} value={level}>{REASONING_LABELS[level]}</option>)}
      </select>
      <p className="text-[11px] text-slate-500">모델이 지원하지 않는 수준은 API에서 거부될 수 있습니다.</p>
    </div>
  );
}
