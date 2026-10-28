import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

/** Own one subscription generation, including its reconnects and refreshes. */
export function subscribeToFriendChanges(client: Pick<SupabaseClient, 'channel' | 'removeChannel'>, userId: string, friendIds: string[], refresh: () => Promise<void>) {
  let disposed = false, connected = false, failed = false, failures = 0;
  let channel: RealtimeChannel | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined, retryTimer: ReturnType<typeof setTimeout> | undefined;
  let reading = false, readAgain = false, quietTicks = 0;

  async function read() {
    if (disposed) return;
    if (reading) { readAgain = true; return; }
    reading = true;
    try { await refresh(); } catch { /* The caller retains and displays read errors. */ }
    finally {
      reading = false; quietTicks = 0;
      if (readAgain) { readAgain = false; changed(); }
    }
  }
  function changed() {
    // A continuous stream must not postpone the refresh forever, or repeatedly
    // abort a slow read. Coalesce it into one read and at most one follow-up.
    if (disposed || updateTimer !== undefined) return;
    updateTimer = setTimeout(() => { updateTimer = undefined; void read(); }, 100);
  }
  function cancelRetry() { clearTimeout(retryTimer); retryTimer = undefined; }
  function connect() {
    if (disposed) return;
    cancelRetry(); connected = false; failed = false;
    const previous = channel;
    // The SDK returns an existing channel for the same topic. A previous
    // asynchronous unsubscribe must never tear down its replacement.
    const current = client.channel(`friends:${userId}:${crypto.randomUUID()}`);
    channel = current;
    if (previous) void client.removeChannel(previous).catch(() => {});
    const notify = () => { if (!disposed && channel === current) changed(); };
    current
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships', filter: `user_a=eq.${userId}` }, notify)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships', filter: `user_b=eq.${userId}` }, notify);
    const ids = [userId, ...friendIds];
    for (let offset = 0; offset < ids.length; offset += 90) current.on('postgres_changes', { event: '*', schema: 'public', table: 'friend_activity_signals', filter: `user_id=in.(${ids.slice(offset, offset + 90).join(',')})` }, notify);
    current.subscribe(status => {
      if (disposed || channel !== current) return;
      if (status === 'SUBSCRIBED') {
        connected = true; failed = false; failures = 0; cancelRetry();
        changed(); // Catch changes made while the socket was disconnected.
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        connected = false; failed = true; changed();
        if (retryTimer === undefined) retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000));
      }
    });
  }
  const wake = () => {
    if (document.visibilityState === 'hidden' || disposed) return;
    if (failed) connect();
    changed();
  };
  const fallback = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (!connected || ++quietTicks >= 3) { quietTicks = 0; changed(); }
  }, 5000);
  window.addEventListener('focus', wake); window.addEventListener('online', wake); window.addEventListener('pageshow', wake);
  document.addEventListener('visibilitychange', wake);
  connect(); changed();
  return () => {
    disposed = true; clearTimeout(updateTimer); cancelRetry(); clearInterval(fallback);
    window.removeEventListener('focus', wake); window.removeEventListener('online', wake); window.removeEventListener('pageshow', wake);
    document.removeEventListener('visibilitychange', wake);
    if (channel) void client.removeChannel(channel).catch(() => {});
  };
}
