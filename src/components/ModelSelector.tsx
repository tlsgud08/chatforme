import { useEffect, useMemo, useState } from 'react';
import type { Provider } from '@/types/db';
import { capabilitiesFor, defaultReasoningFor, EFFORT_LABELS } from '@/lib/llm/modelCapabilities';
import { getOpenRouterModel, isModelVerified } from '@/lib/llm/modelDiscovery';
import type { ReasoningSelection } from '@/lib/llm/types';
import { loadCustomModels, loadFavoriteModels, modelsFor, removeCustomModel, saveCustomModel, toggleFavoriteModel } from '@/lib/modelPreferences';

interface Props {
  provider: Provider;
  model: string;
  reasoning: ReasoningSelection;
  onModelChange: (model: string) => void;
  onReasoningChange: (reasoning: ReasoningSelection) => void;
  favoritesOnly?: boolean;
}

const RELEASE_LABEL = { stable: 'Stable', preview: 'Preview', alias: 'Alias' } as const;
const AVAILABILITY_LABEL = { verified: 'OpenRouter 확인됨', unverified: '접근 미확인', unavailable: '사용 불가' } as const;

function vendorOf(modelId: string) {
  if (!modelId.includes('/')) return '기타';
  // OpenRouter may return provider-routing aliases such as
  // `~anthropic/claude-sonnet-latest`. Keep those aliases in the same company
  // category as canonical `anthropic/*` models instead of creating a separate
  // `~anthropic` category containing only a handful of `latest` aliases.
  return modelId.split('/')[0].replace(/^~+/, '');
}

export default function ModelSelector({ provider, model, reasoning, onModelChange, onReasoningChange, favoritesOnly = false }: Props) {
  const [customInput, setCustomInput] = useState('');
  const [search, setSearch] = useState('');
  const [vendor, setVendor] = useState('전체');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [favorites, setFavorites] = useState(loadFavoriteModels);
  const models = modelsFor(provider);
  const custom = loadCustomModels()[provider];
  const registeredCapability = capabilitiesFor(provider, model);
  const capability = isModelVerified(model)
    ? { ...registeredCapability, availability: 'verified' as const }
    : registeredCapability;
  const currentCatalog = getOpenRouterModel(model);

  const vendors = useMemo(
    () => ['전체', '즐겨찾기', ...new Set(models.map(vendorOf).sort((a, b) => a.localeCompare(b)))],
    [models.join('|')],
  );
  const filteredModels = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const candidates = favoritesOnly ? models.filter((item) => favorites.includes(item)) : models;
    return candidates.filter((item) => {
      if (vendor === '즐겨찾기' && !favorites.includes(item)) return false;
      if (vendor !== '전체' && vendor !== '즐겨찾기' && vendorOf(item) !== vendor) return false;
      // `~provider/*-latest` entries are OpenRouter routing aliases, not the
      // provider's detailed model catalog. Hide them in a company category
      // when canonical models for that company are available.
      if (vendor !== '전체' && vendor !== '즐겨찾기' && item.startsWith('~')) {
        const hasCanonicalModels = models.some((candidate) => !candidate.startsWith('~') && vendorOf(candidate) === vendor);
        if (hasCanonicalModels) return false;
      }
      const info = getOpenRouterModel(item);
      return !needle || item.toLowerCase().includes(needle) || info?.name.toLowerCase().includes(needle);
    }).sort((a, b) => {
      const aName = getOpenRouterModel(a)?.name ?? capabilitiesFor(provider, a).displayName;
      const bName = getOpenRouterModel(b)?.name ?? capabilitiesFor(provider, b).displayName;
      return aName.localeCompare(bName);
    });
  }, [models.join('|'), favorites.join('|'), favoritesOnly, provider, search, vendor]);

  useEffect(() => {
    const effortValid = !reasoning.effort || capability.supportedEfforts.includes(reasoning.effort);
    if (!effortValid || reasoning.mode) onReasoningChange(defaultReasoningFor(provider, model));
  }, [provider, model, reasoning.effort, reasoning.mode]);

  function selectModel(nextModel: string) {
    onModelChange(nextModel);
    onReasoningChange(defaultReasoningFor(provider, nextModel));
    setBrowserOpen(false);
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
      <button
        type="button"
        aria-expanded={browserOpen}
        onClick={() => setBrowserOpen((open) => !open)}
        className="flex w-full items-center gap-3 rounded-lg bg-surface px-3 py-2.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{currentCatalog?.name ?? capability.displayName}</span>
          <span className="block truncate text-[11px] text-slate-500">{model}</span>
        </span>
        <span className="text-xs text-slate-400">{browserOpen ? '닫기 ▲' : '찾기 ▼'}</span>
      </button>

      {browserOpen && (
        <div className="rounded-xl border border-surface2 bg-bg p-3">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="모델 이름 또는 ID 검색"
            autoFocus
            className="w-full rounded-lg bg-surface px-3 py-2.5 text-sm outline-none"
          />
          {!favoritesOnly && <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
            {vendors.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => { setVendor(item); setSearch(''); }}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${vendor === item ? 'bg-brand text-white' : 'bg-surface text-slate-400'}`}
              >
                {item}
              </button>
            ))}
          </div>}
          <p className="mt-2 text-[11px] text-slate-500">{favoritesOnly ? `즐겨찾기 ${filteredModels.length}개` : `${filteredModels.length}개 모델`}</p>
          <div className="mt-1 max-h-72 divide-y divide-surface2 overflow-y-auto rounded-lg bg-surface">
            {filteredModels.length === 0 ? (
              <p className="p-4 text-center text-xs text-slate-500">{favoritesOnly ? '설정에서 모델을 즐겨찾기에 추가해 주세요.' : '검색 결과가 없습니다.'}</p>
            ) : filteredModels.map((item) => {
              const catalog = getOpenRouterModel(item);
              const selected = item === model;
              return (
                <div
                  key={item}
                  className={`flex w-full items-center ${selected ? 'bg-brand/20' : ''}`}
                >
                  <button type="button" onClick={() => selectModel(item)} className="min-w-0 flex-1 px-3 py-2.5 text-left">
                    <span className={`block text-sm ${selected ? 'font-semibold text-brand' : 'text-white'}`}>{catalog?.name ?? capabilitiesFor(provider, item).displayName}</span>
                    <span className="block break-all text-[11px] text-slate-500">{item}</span>
                  </button>
                  {!favoritesOnly && (
                    <button
                      type="button"
                      aria-label={favorites.includes(item) ? `${item} 즐겨찾기 해제` : `${item} 즐겨찾기 추가`}
                      onClick={() => setFavorites(toggleFavoriteModel(item))}
                      className={`self-stretch px-3 text-xl ${favorites.includes(item) ? 'text-amber-400' : 'text-slate-600'}`}
                    >
                      {favorites.includes(item) ? '★' : '☆'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-surface2 p-2.5 text-[11px] text-slate-400">
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded bg-surface2 px-1.5 py-0.5">{RELEASE_LABEL[capability.release]}</span>
          <span className="rounded bg-surface2 px-1.5 py-0.5">{AVAILABILITY_LABEL[capability.availability]}</span>
          <span>{capability.profile}</span>
        </div>
        <p className="mt-1 break-all">ID: {capability.modelId}</p>
        {currentCatalog?.contextLength && <p>컨텍스트: {currentCatalog.contextLength.toLocaleString()} tokens</p>}
      </div>

      {!favoritesOnly && <div className="flex gap-2">
        <input value={customInput} onChange={(event) => setCustomInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } }} placeholder="OpenRouter 모델 ID 직접 입력" className="min-w-0 flex-1 rounded-lg bg-surface px-3 py-2.5 text-sm outline-none" />
        <button type="button" onClick={addModel} className="rounded-lg bg-surface2 px-3 text-xs font-semibold text-white">저장</button>
      </div>}
      {!favoritesOnly && custom.includes(model) && <button type="button" onClick={() => { removeCustomModel(provider, model); selectModel(modelsFor(provider)[0]); setRevision((value) => value + 1); }} className="self-end text-xs text-red-400">저장한 모델 삭제</button>}

      {capability.supportedEfforts.length > 0 ? (
        <>
          <label className="mt-1 text-xs text-slate-400">OpenRouter 추론 수준</label>
          <select value={reasoning.effort ?? ''} onChange={(event) => onReasoningChange({ effort: event.target.value || undefined })} className="w-full rounded-lg bg-surface px-3 py-2.5 text-sm text-white outline-none">
            {!capability.defaultEffort && <option value="">OpenRouter 기본값 (별도 전송 안 함)</option>}
            {capability.supportedEfforts.map((effort) => <option key={effort} value={effort}>{EFFORT_LABELS[effort] ?? effort}{effort === capability.defaultEffort ? ' · 기본값' : ''}</option>)}
          </select>
          <p className="text-[11px] text-slate-500">{reasoning.effort ? `전송값: reasoning.effort=${reasoning.effort}` : '추론 수준을 별도로 전송하지 않습니다.'}</p>
        </>
      ) : (
        <p className="text-[11px] text-slate-500">OpenRouter가 이 모델의 reasoning 지원을 보고하지 않았습니다.</p>
      )}
      {capability.notes?.map((note) => <p key={note} className="text-[11px] text-amber-500">{note}</p>)}
    </div>
  );
}
