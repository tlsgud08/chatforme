const MODEL_CATALOG_KEY = 'inuchat.openrouter.modelCatalog';
const LEGACY_VERIFIED_MODELS_KEY = 'inuchat.openrouter.verifiedModels';

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  supportedParameters: string[];
  contextLength?: number;
}

export function loadOpenRouterModels(): OpenRouterModelInfo[] {
  try {
    const stored = localStorage.getItem(MODEL_CATALOG_KEY);
    if (stored) return JSON.parse(stored) as OpenRouterModelInfo[];
    const legacy = JSON.parse(localStorage.getItem(LEGACY_VERIFIED_MODELS_KEY) ?? '[]') as string[];
    return legacy.map((id) => ({ id, name: id, supportedParameters: [] }));
  } catch {
    return [];
  }
}

export function getOpenRouterModel(modelId: string): OpenRouterModelInfo | undefined {
  return loadOpenRouterModels().find((model) => model.id === modelId);
}

export function isModelVerified(modelId: string): boolean {
  return Boolean(getOpenRouterModel(modelId));
}

export async function discoverOpenRouterModels(apiKey: string): Promise<OpenRouterModelInfo[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`OpenRouter 모델 목록 조회 실패 (${response.status})`);
  const body = await response.json();
  const models = ((body.data ?? []) as {
    id?: string;
    name?: string;
    supported_parameters?: string[];
    context_length?: number;
  }[])
    .filter((model) => Boolean(model.id))
    .map((model) => ({
      id: model.id!,
      name: model.name || model.id!,
      supportedParameters: model.supported_parameters ?? [],
      contextLength: model.context_length,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  localStorage.setItem(MODEL_CATALOG_KEY, JSON.stringify(models));
  return models;
}
