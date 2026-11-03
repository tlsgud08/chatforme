import { supabase } from './supabase';

/** A live browser renews its own draft, including during silent model reasoning.
 * The server expires only opted-in heartbeats; older clients keep their grace. */
export function startResponseHeartbeat(sessionId: string, messageId: string, controller: AbortController): () => void {
  const stopped = new AbortController();
  let pending = false;
  const tick = async () => {
    if (pending || stopped.signal.aborted || controller.signal.aborted) return;
    pending = true;
    try {
      const { data, error } = await supabase.rpc('touch_session_response', {
        target_session: sessionId, target_message: messageId,
      }).abortSignal(AbortSignal.any([stopped.signal, AbortSignal.timeout(10_000)]));
      if (!stopped.signal.aborted && !error && data === false) controller.abort('응답 생성 상태가 변경되어 수신을 중단했습니다.');
    } catch { /* A transient outage must not discard already received output. */ }
    finally { pending = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 20_000);
  return () => { clearInterval(timer); stopped.abort(); };
}
