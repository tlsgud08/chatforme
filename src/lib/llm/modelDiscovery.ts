const VERIFIED_MODELS_KEY = 'inuchat.openrouter.verifiedModels';

export function loadVerifiedModels(): string[] {
  try {
    return JSON.parse(localStorage.getItem(VERIFIED_MODELS_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function isModelVerified(modelId: string): boolean {
  return loadVerifiedModels().includes(modelId);
}

export async function discoverOpenRouterModels(apiKey: string): Promise<string[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`OpenRouter 모델 목록 조회 실패 (${response.status})`);
  const body = await response.json();
  const modelIds = ((body.data ?? []) as { id?: string }[])
    .map((model) => model.id ?? '')
    .filter(Boolean);
  const unique = [...new Set(modelIds)].sort();
  localStorage.setItem(VERIFIED_MODELS_KEY, JSON.stringify(unique));
  return unique;
}
