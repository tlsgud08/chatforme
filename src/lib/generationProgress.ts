import type { ModelPhase } from './llm/types';

export const generationLabels = {
  idle: '응답 기다리는 중…',
  preparing: '대화 준비 중…',
  requesting: '모델에 요청 중…',
  waiting: '응답 기다리는 중…',
  reasoning: '추론 중…',
  receiving: '답변 받는 중…',
  saving: '답변 저장 중…',
} as const;
export type GenerationStage = keyof typeof generationLabels;
const order: Record<GenerationStage, number> = { idle: 0, preparing: 1, requesting: 2, waiting: 3, reasoning: 4, receiving: 5, saving: 6 };
const modelStages: Partial<Record<ModelPhase, GenerationStage>> = {
  'model-request': 'requesting', 'model-headers': 'waiting', 'model-reasoning': 'reasoning', 'first-content': 'receiving',
};

/** Per-request, in-memory observation only. No timers, storage, network or awaits.
 * Only the small status component subscribes; tokens don't rerender the chat via this store. */
export function createGenerationProgress() {
  let stage: GenerationStage = 'idle';
  let attempt = 0;
  let active = false;
  const listeners = new Set<() => void>();
  function publish(next: GenerationStage) {
    if (next === stage) return;
    stage = next;
    listeners.forEach(listener => { try { listener(); } catch { /* Status is best effort. */ } });
  }
  return {
    getSnapshot: () => stage,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      const id = ++attempt;
      active = true;
      publish('preparing');
      const advance = (next: Exclude<GenerationStage, 'idle'>) => {
        if (active && id === attempt && order[next] > order[stage]) publish(next);
      };
      return {
        advance,
        onPhase(phase: ModelPhase) {
          const next = modelStages[phase];
          // Metadata events don't prove reasoning. Provider completion isn't a DB save.
          if (next && next !== 'idle') advance(next);
        },
        finish() { if (active && id === attempt) { active = false; publish('idle'); } },
      };
    },
  };
}
export type GenerationProgress = ReturnType<typeof createGenerationProgress>;
