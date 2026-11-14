import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { discoverLocalModels } from '@/lib/llm/localTransport';

interface Props { model: string; onModelChange: (model: string) => void; label?: string; emptyLabel?: string; }
export default function LocalModelSelector({ model, onModelChange, label = 'Local 모델', emptyLabel = '실행 중인 모델을 선택하세요' }: Props) {
  const { user } = useAuth();
  const { data, error, isError, isFetching: checking, refetch } = useQuery({
    queryKey: ['local-models', user?.id], queryFn: ({ signal }) => discoverLocalModels(signal),
    enabled: !!user, staleTime: 15_000, refetchInterval: 30_000, retry: false,
  });
  const models = isError ? [] : data?.models ?? [];
  const status = error ? error.message : !data ? '연결 확인 중…' : models.length
    ? 'Local 연결됨 · API 비용 0원' : 'Local 연결됨 · 실행 중인 모델 없음';
  const current = models.find(item => item.id === model);
  return <div className="flex flex-col gap-2 rounded-lg bg-surface p-3">
    <label className="text-xs text-slate-400">{label}
      <select aria-label={label} value={model} onChange={event => onModelChange(event.target.value)} className="mt-1 w-full rounded-lg bg-surface2 px-3 py-2 text-sm text-white">
        <option value="">{emptyLabel}</option>
        {model && !current && <option value={model} disabled>{model} · 실행 상태 미확인</option>}
        {models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.contextLength.toLocaleString()} tokens</option>)}
      </select>
    </label>
    <p role="status" className="text-xs text-slate-400">{status}</p>
    {current && <p className="text-xs text-slate-500">실제 로드 컨텍스트: {current.contextLength.toLocaleString()} 토큰 · 전송 시 입력과 출력 예약량을 다시 검증합니다.</p>}
    <button type="button" disabled={checking} onClick={() => void refetch()} className="text-left text-xs text-brand disabled:opacity-50">{checking ? '연결 확인 중…' : '연결·모델 새로고침'}</button>
  </div>;
}
