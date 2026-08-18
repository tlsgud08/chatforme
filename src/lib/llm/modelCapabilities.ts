import type { Provider } from '@/types/db';
import type { ReasoningSelection } from './types';

export type ModelAvailability = 'verified' | 'unverified' | 'unavailable';
export type ModelRelease = 'stable' | 'preview' | 'alias';
export type ReasoningKind = 'openrouter_reasoning' | 'none';

export interface ModelCapabilities {
  provider: Provider;
  modelId: string;
  displayName: string;
  availability: ModelAvailability;
  release: ModelRelease;
  reasoningKind: ReasoningKind;
  supportedEfforts: readonly string[];
  defaultEffort?: string;
  profile: string;
  notes?: readonly string[];
}

const GPT_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * OpenRouter model IDs only. These are candidates until the user's OpenRouter
 * /models response confirms access; no direct-provider endpoint is used.
 */
export const MODEL_CAPABILITIES: readonly ModelCapabilities[] = [
  { provider: 'openrouter', modelId: 'openai/gpt-5.6-sol', displayName: 'GPT-5.6 Sol', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: GPT_EFFORTS, defaultEffort: 'medium', profile: '최상위 품질' },
  { provider: 'openrouter', modelId: 'openai/gpt-5.6', displayName: 'GPT-5.6 (Sol alias)', availability: 'unverified', release: 'alias', reasoningKind: 'openrouter_reasoning', supportedEfforts: GPT_EFFORTS, defaultEffort: 'medium', profile: 'Sol 별칭' },
  { provider: 'openrouter', modelId: 'openai/gpt-5.6-terra', displayName: 'GPT-5.6 Terra', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: GPT_EFFORTS, defaultEffort: 'medium', profile: '균형형' },
  { provider: 'openrouter', modelId: 'openai/gpt-5.6-luna', displayName: 'GPT-5.6 Luna', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: GPT_EFFORTS, defaultEffort: 'medium', profile: '속도·비용 중시' },
  { provider: 'openrouter', modelId: 'anthropic/claude-fable-5', displayName: 'Claude Fable 5', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: CLAUDE_EFFORTS, defaultEffort: 'high', profile: '장기 에이전트 작업' },
  { provider: 'openrouter', modelId: 'anthropic/claude-opus-5', displayName: 'Claude Opus 5', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: CLAUDE_EFFORTS, defaultEffort: 'high', profile: '최상위 품질' },
  { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-5', displayName: 'Claude Sonnet 5', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'high', profile: '품질·속도 균형' },
  { provider: 'openrouter', modelId: 'anthropic/claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', availability: 'unverified', release: 'stable', reasoningKind: 'none', supportedEfforts: [], profile: '빠르고 저렴함' },
  { provider: 'openrouter', modelId: 'anthropic/claude-haiku-4-5', displayName: 'Claude Haiku 4.5 (alias)', availability: 'unverified', release: 'alias', reasoningKind: 'none', supportedEfforts: [], profile: '빠르고 저렴함' },
  { provider: 'openrouter', modelId: 'google/gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium', profile: '최신 고속 모델' },
  { provider: 'openrouter', modelId: 'google/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro', availability: 'unverified', release: 'preview', reasoningKind: 'openrouter_reasoning', supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'high', profile: '고품질 Preview' },
  { provider: 'openrouter', modelId: 'google/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium', profile: '안정적인 고속 모델' },
  { provider: 'openrouter', modelId: 'google/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium', profile: '저비용' },
  { provider: 'openrouter', modelId: 'google/gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite', availability: 'unverified', release: 'stable', reasoningKind: 'openrouter_reasoning', supportedEfforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium', profile: '저비용 이전 세대' },
];

export function capabilitiesFor(_provider: Provider, modelId: string): ModelCapabilities {
  return MODEL_CAPABILITIES.find((item) => item.modelId === modelId) ?? {
    provider: 'openrouter', modelId, displayName: modelId, availability: 'unverified',
    release: 'stable', reasoningKind: 'none', supportedEfforts: [], profile: '직접 등록 모델',
    notes: ['OpenRouter capability가 확인되지 않아 추론 설정을 전송하지 않습니다.'],
  };
}

export function modelsForProvider(_provider: Provider): ModelCapabilities[] {
  return [...MODEL_CAPABILITIES];
}

export function defaultReasoningFor(provider: Provider, modelId: string): ReasoningSelection {
  return { effort: capabilitiesFor(provider, modelId).defaultEffort };
}

export function validateReasoning(provider: Provider, modelId: string, selection: ReasoningSelection): ModelCapabilities {
  const capability = capabilitiesFor(provider, modelId);
  if (selection.effort && !capability.supportedEfforts.includes(selection.effort)) {
    throw new Error(`${modelId}은(는) OpenRouter 추론 단계 '${selection.effort}'을 지원하지 않습니다.`);
  }
  return capability;
}

export const EFFORT_LABELS: Record<string, string> = {
  none: '없음 (none)', minimal: '최소 (minimal)', low: '낮음 (low)', medium: '보통 (medium)', high: '높음 (high)', xhigh: '매우 높음 (xhigh)', max: '최대 (max)',
};
