import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { fetchWorkRankings } from '@/lib/workRanking';
import { useWorkCredits } from '@/lib/workCredits';
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
  const creditsEnabled = useWorkCredits();
  const [krw, setKrw] = useState(readsKrw);
  useEffect(() => {
    const refresh = () => setKrw(readsKrw());
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  const { data, isError, refetch, isFetching } = useQuery({
    queryKey: ['work-display-stats', user?.id, workId, creditsEnabled],
    queryFn: async ({ signal }) => {
      const rows = await fetchWorkRankings([workId], signal, creditsEnabled);
      return rows[workId];
    },
    enabled: !!user,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  return <>
    <span className="inline-flex items-center gap-1" title="채팅방 수 / 활성 사용자 턴 합계" aria-label={data ? `총 ${data.sessions.toLocaleString('ko-KR')}세션 / ${data.messages.toLocaleString('ko-KR')}턴` : '세션과 턴 집계'}>
      <InterfaceIcon name="chat" />{data ? `${data.sessions.toLocaleString('ko-KR')}세션 / ${data.messages.toLocaleString('ko-KR')}턴` : isError ? '—' : '…'}
    </span>
    {creditsEnabled && <span className="inline-flex items-center gap-1" title="이 작품의 모든 채팅방에 기록된 누적 API 비용" aria-label="작품 총 사용 금액">
      <InterfaceIcon name="cost" />{data?.dollars !== undefined ? krw ? <WonCost dollars={data.dollars} /> : `$${data.dollars.toFixed(6)}` : isError ? '—' : '…'}
    </span>}
    {isError && <button type="button" disabled={isFetching} onClick={() => void refetch()} className="underline disabled:opacity-50">통계 다시 불러오기</button>}
  </>;
}
