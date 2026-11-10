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
}
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
export const discoverLocalModels = (signal?: AbortSignal) => localRPC<{ online: true; models: LocalModelInfo[] }>({ action: 'models' }, signal);
