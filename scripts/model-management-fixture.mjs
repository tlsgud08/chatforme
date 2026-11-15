import { fixture } from './local-gateway-fixture.mjs';

export async function managementFixture(options = {}) {
  const calls = [], active = [];
  const installed = ['fixture/local', 'fixture/second'].map(modelKey => ({ modelKey, displayName: modelKey, maxContextLength: 262144, deviceIdentifier: null, type: 'llm' }));
  const makeModel = (identifier, modelKey = identifier, context = 8192) => {
    const config = { contextLength: context, flashAttention: true, gpu: { ratio: 0.75 } };
    const model = { identifier, modelKey, instanceReference: crypto.randomUUID(),
      getContextLength: async () => config.contextLength,
      getLoadConfig: async () => structuredClone(config),
      getModelInfo: async () => ({ deviceIdentifier: null, ttlMs: 600000 }),
      applyPromptTemplate: async messages => JSON.stringify(messages), countTokens: async () => 100,
      unload: async () => { calls.push(['unload', identifier]); if (options.unload) await options.unload(); active.splice(active.indexOf(model), 1); },
    };
    active.push(model); return model;
  };
  const inspector = { listLoaded: async () => [...active], load: async (modelKey, opts) => {
    calls.push(['load', modelKey, { ...opts, signal: undefined, onProgress: undefined }]); opts.onProgress(0.4);
    if (options.load) await options.load(opts);
    opts.signal.throwIfAborted();
    return makeModel(opts.identifier, modelKey, options.actualContext ?? opts.config.contextLength);
  } };
  const system = { listDownloadedModels: async domain => { calls.push(['catalog', domain]); return [...installed]; },
    listDownloadedModelVariants: async () => options.variants ?? [] };
  const first = makeModel('fixture/local');
  const f = await fixture({ catalog: () => active.map(model => ({ id: model.identifier })), respond: options.respond,
    gateway: { inspector, system, allowModelManagement: options.enabled ?? true } });
  const load = (input = {}, requestId = crypto.randomUUID()) => f.rpc({ action: 'load-model', requestId, modelKey: 'fixture/second', contextLength: 131072, ...input });
  return { ...f, calls, active, first, installed, makeModel, inspector, system, load };
}
