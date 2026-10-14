import { supabase } from '@/lib/supabase';

/** Preserve the existing completed-AI-turn count, with a safe rollout fallback. */
export async function fetchSessionConversationCounts(sessionIds: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (!sessionIds.length) return counts;
  try {
    // Keep each RPC below the usual response row limit even for large accounts.
    for (let offset = 0; offset < sessionIds.length; offset += 500) {
      const batch = sessionIds.slice(offset, offset + 500);
      const { data, error } = await supabase.rpc('session_conversation_counts', { target_session_ids: batch });
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
  } catch {
    // Old deployments or an unavailable RPC still display exact counts.
    await Promise.all(sessionIds.map(async id => {
      const { count, error } = await supabase.from('messages')
        .select('id', { count: 'exact', head: true }).eq('session_id', id)
        .eq('role', 'assistant').eq('is_hidden', false).eq('is_active_variant', true).gt('turn_index', 0);
      if (error) throw error;
      counts[id] = count ?? 0;
    }));
    return counts;
  }
}
