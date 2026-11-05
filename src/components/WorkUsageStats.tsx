import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { formatKrw, useUsdKrwRate } from '@/lib/exchangeRate';
import InterfaceIcon from './InterfaceIcon';

const currencyKey = 'inuchat.showCostKrw';
function readsKrw() {
  try { return localStorage.getItem(currencyKey) === '1'; } catch { return false; }
}
function WonCost({ dollars }: { dollars: number }) {
  const exchange = useUsdKrwRate();
  return <span title={exchange.fallback ? '임시 환율로 환산한 금액' : '현재 환율로 환산한 금액'}>{formatKrw(dollars, exchange.rate)}</span>;
}

export default function WorkUsageStats({ workId }: { workId: string }) {
  const { user } = useAuth();
  const [krw, setKrw] = useState(readsKrw);
  useEffect(() => {
    const refresh = () => setKrw(readsKrw());
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  const { data, isError, refetch, isFetching } = useQuery({
    queryKey: ['work-usage', user?.id, workId],
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.rpc('work_usage_totals', { target_work: workId }, { get: true }).abortSignal(signal);
      if (error) throw error;
      const row = data?.[0];
      const turns = Number(row?.turn_count), dollars = Number(row?.total_cost_usd);
      if (!row || !Number.isSafeInteger(turns) || turns < 0 || !Number.isFinite(dollars) || dollars < 0) throw new Error('Invalid work usage');
      return { turns, dollars };
    },
    enabled: !!user,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  return <>
    <span className="inline-flex items-center gap-1" title="이 작품의 모든 채팅방에 남아 있는 사용자 턴 합계" aria-label={data ? `총 ${data.turns.toLocaleString('ko-KR')}턴 플레이` : '플레이 턴 집계'}>
      <InterfaceIcon name="chat" />{data ? `${data.turns.toLocaleString('ko-KR')}턴` : isError ? '—' : '…'}
    </span>
    <span className="inline-flex items-center gap-1" title="이 작품의 모든 채팅방에 기록된 누적 API 비용" aria-label="작품 총 사용 금액">
      <InterfaceIcon name="cost" />{data ? krw ? <WonCost dollars={data.dollars} /> : `$${data.dollars.toFixed(6)}` : isError ? '—' : '…'}
    </span>
    {isError && <button type="button" disabled={isFetching} onClick={() => void refetch()} className="underline disabled:opacity-50">통계 다시 불러오기</button>}
  </>;
}
