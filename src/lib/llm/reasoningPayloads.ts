import { validateReasoning } from './modelCapabilities';
import type { ReasoningSelection } from './types';

export function openRouterReasoningPayload(model: string, selection: ReasoningSelection) {
  const capability = validateReasoning('openrouter', model, selection);
  if (capability.reasoningKind !== 'openrouter_reasoning' || !selection.effort) return {};
  return { reasoning: { effort: selection.effort } };
}
