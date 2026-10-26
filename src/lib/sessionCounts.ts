import { supabase } from '@/lib/supabase';
import type { QueryClient } from '@tanstack/react-query';

/** Count the same visible active user turns as the chat and summary checkpoints. */
export function sessionCountsKey(userId: string | undefined, ids: string[]) {
  return ['session-counts', userId, [...new Set(ids)].sort()] as const;
}

/** Only update cached sets which actually contain this room, within its account. */
export function cacheSessionCount(client: QueryClient, userId: string, sessionId: string, count: number) {
  client.setQueriesData<Record<string, number>>({ queryKey: ['session-counts', userId] }, current =>
    current && Object.prototype.hasOwnProperty.call(current, sessionId) ? { ...current, [sessionId]: count } : current);
}

export async function fetchSessionConversationCounts(sessionIds: string[], signal?: AbortSignal): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (!sessionIds.length) return counts;
  try {
    // Keep each RPC below the usual response row limit even for large accounts.
    for (let offset = 0; offset < sessionIds.length; offset += 500) {
      const batch = sessionIds.slice(offset, offset + 500);
      let query = supabase.rpc('session_conversation_counts', { target_session_ids: batch });
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query;
      if (error || !Array.isArray(data)) throw error ?? new Error('Invalid conversation counts');
      const rows = new Map(data.map((row: { session_id: string; conversation_count: number | string }) => [row.session_id, Number(row.conversation_count)]));
      // Every accessible session is returned, including empty ones. Do not
      // silently accept truncated responses or treat inaccessible IDs as zero.
      for (const id of batch) {
        const count = rows.get(id);
        if (count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error('Incomplete conversation counts');
        counts[id] = count;
      }
    }
    return counts;
  } catch (error) {
    // A transient/network failure must not fan out into one request per room.
    // Only an old schema without this RPC needs the compatibility path.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (signal?.aborted || (code !== 'PGRST202' && code !== '42883')) throw error;
    for (let offset = 0; offset < sessionIds.length; offset += 4) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      await Promise.all(sessionIds.slice(offset, offset + 4).map(async id => {
        let query = supabase.from('messages')
          .select('id', { count: 'exact', head: true }).eq('session_id', id)
          .eq('role', 'user').eq('is_hidden', false).eq('is_active_variant', true);
        if (signal) query = query.abortSignal(signal);
        const { count, error } = await query;
        if (error) throw error;
        counts[id] = count ?? 0;
      }));
    }
    return counts;
  }
}
