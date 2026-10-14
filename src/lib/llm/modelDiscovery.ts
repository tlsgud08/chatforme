const MODEL_CATALOG_KEY = 'inuchat.openrouter.modelCatalog';
const LEGACY_VERIFIED_MODELS_KEY = 'inuchat.openrouter.verifiedModels';

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  supportedParameters: string[];
  contextLength?: number;
}

let cachedSource: string | null | undefined;
let cachedLegacy = false;
let catalog: OpenRouterModelInfo[] = [];
let catalogById = new Map<string, OpenRouterModelInfo>();

export function loadOpenRouterModels(): OpenRouterModelInfo[] {
  try {
    const stored = localStorage.getItem(MODEL_CATALOG_KEY);
    const legacy = stored ? null : localStorage.getItem(LEGACY_VERIFIED_MODELS_KEY);
    const source = stored || legacy || '[]';
    const isLegacy = !stored;
    // Compare the saved value so same-tab updates, other tabs and test clients
    // invalidate the cache without polling or permanently caching old metadata.
    if (source === cachedSource && isLegacy === cachedLegacy) return catalog;
    const parsed = JSON.parse(stored || legacy || '[]');
    catalog = Array.isArray(parsed)
      ? stored ? parsed as OpenRouterModelInfo[] : parsed.map((id: string) => ({ id, name: id, supportedParameters: [] }))
      : [];
    catalogById = new Map(catalog.map(model => [model.id, model]));
    cachedSource = source;
    cachedLegacy = isLegacy;
    return catalog;
  } catch {
    cachedSource = undefined;
    catalog = [];
    catalogById.clear();
    return catalog;
  }
}

export function getOpenRouterModel(modelId: string): OpenRouterModelInfo | undefined {
  loadOpenRouterModels();
  return catalogById.get(modelId);
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
