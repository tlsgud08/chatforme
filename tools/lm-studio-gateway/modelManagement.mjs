import { LocalError, fail } from './protocol.mjs';

/** Only installed, local LLMs are eligible. Never accept paths, URLs or arbitrary SDK config. */
export function createModelManager({ inspector, system, enabled, wait }) {
  async function catalog(signal) {
    if (!enabled) fail('LOCAL_MANAGEMENT_DISABLED', 'PC 게이트웨이에서 원격 모델 관리를 허용해야 합니다.', 403);
    const installed = await wait(system.listDownloadedModels('llm'), signal);
    const variants = [];
    for (const item of installed) {
      if (item.deviceIdentifier != null) continue;
      variants.push(item);
      if (item.variants?.length) variants.push(...await wait(system.listDownloadedModelVariants(item.modelKey), signal));
    }
    return [...new Map(variants.filter(item => item.deviceIdentifier == null && (item.type === undefined || item.type === 'llm'))
      .map(item => [item.modelKey, { key: item.modelKey, name: item.displayName || item.modelKey,
        maxContextLength: Number.isSafeInteger(item.maxContextLength) && item.maxContextLength > 0 ? item.maxContextLength : null }])).values()];
  }
  async function run(job, input) {
    let unloaded = false;
    try {
      const signal = job.controller.signal;
      job.stage = '설치된 모델 확인 중';
      const installed = await catalog(signal);
      const info = installed.find(item => item.key === input.modelKey);
      if (!info) fail('LOCAL_MODEL_NOT_INSTALLED', 'PC에 다운로드된 로컬 LLM만 로드할 수 있습니다.', 404);
      if (!info.maxContextLength) fail('LOCAL_CONTEXT_UNKNOWN', '모델의 지원 컨텍스트 상한을 확인할 수 없어 로드를 중단했습니다.', 409);
      if (!Number.isSafeInteger(input.contextLength) || input.contextLength < 256 || input.contextLength > info.maxContextLength)
        fail('LOCAL_INVALID_CONTEXT', `컨텍스트는 256~${info.maxContextLength.toLocaleString()} 사이의 정수로 입력하세요.`, 400);
      const loaded = await wait(inspector.listLoaded(), signal);
      let config = {}, identifier = input.modelKey, ttl;
      if (input.targetId) {
        const target = loaded.find(item => item.identifier === input.targetId);
        if (!target || !input.expectedInstance || target.instanceReference !== input.expectedInstance || target.modelKey !== input.modelKey)
          fail('LOCAL_MODEL_CHANGED', '모델 실행 상태가 변경되었습니다. 목록을 새로고침한 뒤 다시 적용하세요.', 409);
        const targetInfo = await wait(target.getModelInfo(), signal);
        if (targetInfo.deviceIdentifier !== null) fail('LOCAL_MODEL_CHANGED', '이 PC에서 실행 중인 모델만 재로드할 수 있습니다.', 409);
        if (Number.isFinite(targetInfo.ttlMs) && targetInfo.ttlMs > 0) ttl = Math.ceil(targetInfo.ttlMs / 1000);
        config = await wait(target.getLoadConfig(), signal);
        identifier = target.identifier;
        signal.throwIfAborted();
        job.stage = '선택한 모델 재로드 중';
        // Unloading cannot be cancelled. Keep the global lock until it actually finishes.
        await target.unload(); unloaded = true;
        signal.throwIfAborted();
      } else if (loaded.some(item => item.modelKey === input.modelKey || item.identifier === identifier)) {
        fail('LOCAL_MODEL_CHANGED', '이미 로드된 모델입니다. 실행 중인 모델 목록에서 컨텍스트를 변경하세요.', 409);
      }
      job.stage = '모델 로드 중';
      const model = await inspector.load(input.modelKey, { identifier, deviceIdentifier: null, ...(ttl !== undefined && { ttl }), config: { ...config, contextLength: input.contextLength },
        signal, verbose: false, onProgress: p => { if (Number.isFinite(p)) job.progress = Math.max(0, Math.min(1, p)); } });
      const contextLength = await wait(model.getContextLength(), signal);
      if (contextLength !== input.contextLength) fail('LOCAL_CONTEXT_NOT_APPLIED',
        `요청한 컨텍스트 ${input.contextLength.toLocaleString()} 대신 실제 ${contextLength} 토큰으로 로드되었습니다. 실행 목록을 확인하고 PC 메모리와 모델 설정을 조정하세요.`, 409);
      job.result = { id: model.identifier, contextLength };
      job.progress = 1; job.stage = '로드 완료';
    } catch (error) {
      if (job.controller.signal.aborted) fail('LOCAL_CANCELLED', `모델 로드를 중단했습니다.${unloaded ? ' 재로드하던 모델은 언로드되어 있을 수 있습니다.' : ''}`, 409);
      if (error instanceof LocalError) throw error;
      fail('LOCAL_MODEL_LOAD_FAILED', `모델 로드에 실패했습니다. PC의 RAM/VRAM, 모델과 컨텍스트 설정을 확인하세요.${unloaded ? ' 기존 모델이 언로드되어 있으므로 목록을 확인한 뒤 다시 로드하세요.' : ''}`, 503);
    }
  }
  return { enabled, catalog, run };
}
