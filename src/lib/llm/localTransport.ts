import { supabase } from '@/lib/supabase';

export class LocalAPIError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'LocalAPIError'; }
}
export interface LocalModelInfo {
  id: string;
  name: string;
  contextLength: number;
  supportedParameters: string[];
  reasoningFormat: 'separate' | 'think-tags';
  modelKey?: string;
  instanceId?: string;
}
export interface LocalModels { online: true; models: LocalModelInfo[]; managementEnabled?: boolean; }
export interface LocalModelCatalog extends LocalModels { downloaded: { key: string; name: string; maxContextLength: number | null }[]; }
export async function localRPC<T>(input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) throw new LocalAPIError('UNAUTHORIZED', 'Local을 사용하려면 다시 로그인해 주세요.');
  // Only the existing public Supabase URL/key appear in the browser. No PC/tunnel secrets.
  let response: Response;
  try { response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/local-llm`, { method: 'POST', signal: signal
    ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '' },
    body: JSON.stringify(input) }); }
  catch {
    signal?.throwIfAborted();
    throw new LocalAPIError('LOCAL_OFFLINE', 'Local 오프라인: 네트워크 또는 PC 중계 서버에 연결할 수 없습니다.');
  }
  let result;
  try { result = await response.json(); } catch { throw new LocalAPIError('LOCAL_OFFLINE', 'Local 오프라인: 중계 서버 응답을 확인할 수 없습니다.'); }
  if (!response.ok) throw new LocalAPIError(result.code ?? 'LOCAL_OFFLINE', result.message ?? 'Local 연결에 실패했습니다.');
  return result as T;
}
export const discoverLocalModels = (signal?: AbortSignal) => localRPC<LocalModels>({ action: 'models' }, signal);
export const discoverLocalModelCatalog = (signal?: AbortSignal) => localRPC<LocalModelCatalog>({ action: 'model-catalog' }, signal);

export async function loadRemoteLocalModel(input: { modelKey: string; contextLength: number; targetId?: string; expectedInstance?: string },
  signal: AbortSignal, onProgress: (progress: number, stage: string) => void): Promise<{ id: string; contextLength: number }> {
  let id = '', complete = false;
  try {
    signal.throwIfAborted();
    ({ id } = await localRPC<{ id: string }>({ action: 'load-model', requestId: crypto.randomUUID(), ...input }));
    while (true) {
      signal.throwIfAborted();
      const poll = await localRPC<{ state: string; progress: number; stage: string; error?: { code: string; message: string }; result?: { id: string; contextLength: number } }>({ action: 'poll', id, cursor: 0 }, signal);
      signal.throwIfAborted();
      onProgress(poll.progress, poll.stage || '모델 준비 중');
      if (poll.state === 'error') throw new LocalAPIError(poll.error?.code ?? 'LOCAL_MODEL_LOAD_FAILED', poll.error?.message ?? '모델 로드에 실패했습니다.');
      if (poll.state === 'complete') {
        if (!poll.result) throw new LocalAPIError('LOCAL_MODEL_LOAD_FAILED', '실제 모델 로드 결과를 확인할 수 없습니다.');
        complete = true; return poll.result;
      }
      await new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  } finally { if (id && !complete) void localRPC({ action: 'cancel', id }).catch(() => {}); }
}
