type Env = (name: string) => string | undefined;
const MAX_BODY = 16 * 1024 * 1024;
const KNOWN_ERRORS = new Set(['INVALID_REQUEST', 'LOCAL_BUSY', 'LOCAL_OFFLINE', 'LOCAL_MODEL_UNLOADED', 'LOCAL_CONTEXT_UNKNOWN',
  'LOCAL_CONTEXT_OVERFLOW', 'LOCAL_STREAM_ERROR', 'LOCAL_MODEL_ERROR', 'LOCAL_EMPTY_RESPONSE', 'LOCAL_CANCELLED', 'LOCAL_JOB_NOT_FOUND', 'REQUEST_TOO_LARGE',
  'LOCAL_MANAGEMENT_DISABLED', 'LOCAL_MODEL_NOT_INSTALLED', 'LOCAL_INVALID_CONTEXT', 'LOCAL_MODEL_CHANGED', 'LOCAL_CONTEXT_NOT_APPLIED', 'LOCAL_MODEL_LOAD_FAILED']);

/** Short, authenticated RPCs keep long local inference independent of Edge wall-clock limits. */
export function createLocalProxy(env: Env, fetchImpl: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin') ?? '';
    const origins = (env('LOCAL_ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const allowedOrigin = origins.includes(origin);
    const cors: Record<string, string> = { 'vary': 'Origin', 'cache-control': 'no-store',
      ...(allowedOrigin && { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
        'access-control-allow-methods': 'POST, OPTIONS' }) };
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (!allowedOrigin) return json(403, { code: 'FORBIDDEN', message: '허용되지 않은 사이트입니다.' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED' });
    const bearer = request.headers.get('authorization') ?? '';
    if (!/^Bearer \S+$/.test(bearer)) return json(401, { code: 'UNAUTHORIZED', message: '다시 로그인해 주세요.' });
    try {
      // Online Auth verification, never trust a decoded JWT or user_metadata for authorization.
      const authResponse = await fetchImpl(new URL('/auth/v1/user', env('SUPABASE_URL')), { headers: {
        authorization: bearer, apikey: env('SUPABASE_ANON_KEY') ?? '',
      }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!authResponse.ok) return json(401, { code: 'UNAUTHORIZED', message: '다시 로그인해 주세요.' });
      const user = await authResponse.json();
      const users = (env('LOCAL_ALLOWED_USER_IDS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (!user?.id || user.is_anonymous || !users.includes(user.id)) return json(403, { code: 'FORBIDDEN', message: '이 계정에는 Local PC 사용 권한이 없습니다.' });
      const gatewayUrl = new URL(env('LOCAL_GATEWAY_URL') ?? '');
      const secret = env('LOCAL_GATEWAY_SECRET') ?? '';
      if (gatewayUrl.protocol !== 'https:' || gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash || gatewayUrl.pathname !== '/' || secret.length < 32)
        return json(503, { code: 'LOCAL_NOT_CONFIGURED', message: '서버의 Local HTTPS 중계 설정이 필요합니다.' });
      if (Number(request.headers.get('content-length')) > MAX_BODY) return json(413, { code: 'REQUEST_TOO_LARGE', message: '요청이 16 MiB를 초과했습니다. 대화는 자동으로 자르지 않습니다.' });
      const reader = request.body?.getReader();
      if (!reader) return json(400, { code: 'INVALID_REQUEST' });
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
          if (size > MAX_BODY) { await reader.cancel(); return json(413, { code: 'REQUEST_TOO_LARGE', message: '요청이 16 MiB를 초과했습니다. 대화는 자동으로 자르지 않습니다.' }); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let input;
      try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json(400, { code: 'INVALID_REQUEST' }); }
      if (!input || !['models', 'start', 'poll', 'cancel', 'model-catalog', 'load-model'].includes(input.action)) return json(400, { code: 'INVALID_REQUEST' });
      // Client cannot choose a destination or supply privileged upstream headers.
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'x-chatforme-user-id': user.id };
      if (env('LOCAL_ACCESS_CLIENT_ID') && env('LOCAL_ACCESS_CLIENT_SECRET')) {
        headers['CF-Access-Client-Id'] = env('LOCAL_ACCESS_CLIENT_ID')!;
        headers['CF-Access-Client-Secret'] = env('LOCAL_ACCESS_CLIENT_SECRET')!;
      }
      const upstream = await fetchImpl(new URL('/rpc', gatewayUrl), { method: 'POST', headers, body: JSON.stringify(input),
        redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!upstream.headers.get('content-type')?.includes('application/json')) throw new Error('Gateway offline');
      const data = await upstream.json();
      if (!upstream.ok) {
        if (KNOWN_ERRORS.has(data?.code)) return json(upstream.status, { code: data.code, message: String(data.message ?? '').slice(0, 1000) });
        throw new Error('Gateway unavailable');
      }
      return json(200, data);
    } catch {
      return json(503, { code: 'LOCAL_OFFLINE', message: 'Local 오프라인: PC, LM Studio 서버 및 HTTPS 터널 연결을 확인하세요.' });
    }
  };
}
