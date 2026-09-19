import { validateReasoning } from './modelCapabilities';
import type { ReasoningSelection } from './types';

export function openRouterReasoningPayload(model: string, selection: ReasoningSelection) {
  if (selection.send === false) return {};
  if (selection.effort === 'off') return { reasoning: { enabled: false } };
  const capability = validateReasoning('openrouter', model, selection);
  if (capability.reasoningKind !== 'openrouter_reasoning' || !selection.effort) return {};
  return { reasoning: { effort: selection.effort } };
}
