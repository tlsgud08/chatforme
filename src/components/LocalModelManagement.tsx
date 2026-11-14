import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { discoverLocalModelCatalog, loadRemoteLocalModel } from '@/lib/llm/localTransport';
import { registerAccountTask } from '@/lib/accountTasks';
import { showConfirmDialog } from '@/lib/dialog';

export default function LocalModelManagement() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false), [targetId, setTargetId] = useState(''), [modelKey, setModelKey] = useState('');
  const [context, setContext] = useState('131072'), [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null), mounted = useRef(false), lock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const catalog = useQuery({ queryKey: ['local-model-catalog', user?.id], queryFn: ({ signal }) => discoverLocalModelCatalog(signal), enabled: open && !!user, retry: false, staleTime: 0 });
  const loaded = catalog.data?.models ?? [], downloaded = catalog.data?.downloaded ?? [];
  const target = loaded.find(item => item.id === targetId), selected = downloaded.find(item => item.key === modelKey);
  const refresh = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['local-models', user?.id] }), queryClient.invalidateQueries({ queryKey: ['local-model-catalog', user?.id] })]);
  };
  async function apply() {
    if (lock.current || !selected || !Number.isSafeInteger(Number(context)) || Number(context) < 256 || !selected.maxContextLength || Number(context) > selected.maxContextLength) return;
    lock.current = true;
    const abort = new AbortController(); controller.current = abort;
    const unregister = registerAccountTask(abort);
    const request = { modelKey, contextLength: Number(context), ...(target && { targetId: target.id, expectedInstance: target.instanceId }) };
    try {
      const confirmed = await showConfirmDialog(target ? '모델 컨텍스트를 변경할까요?' : 'PC에서 모델을 로드할까요?',
        `${selected.name}\n${target ? `현재 ${target.contextLength.toLocaleString()} → ` : ''}${Number(context).toLocaleString()} 토큰\n${target ? '선택한 모델을 재로드하며 해당 KV 캐시가 초기화됩니다. ' : ''}PC의 메모리를 사용합니다. 대화 기록은 유지됩니다. 중단 시 모델이 언로드 상태로 남을 수 있습니다.`, target ? '재로드' : '로드');
      if (!confirmed || abort.signal.aborted || !mounted.current) return;
      setBusy(true); setProgress(0); setMessage('모델 준비 중…');
      const result = await loadRemoteLocalModel(request, AbortSignal.any([abort.signal, AbortSignal.timeout(10 * 60_000)]), (p, stage) => {
        if (!mounted.current || abort.signal.aborted) return; setProgress(p); setMessage(stage);
      });
      if (mounted.current && !abort.signal.aborted) setMessage(`로드 완료 · 실제 컨텍스트 ${result.contextLength.toLocaleString()} 토큰. 사용할 모델을 모델 선택란에서 선택하세요.`);
    } catch (error) {
      if (mounted.current) setMessage(abort.signal.aborted ? '모델 로드를 중단했습니다. 실행 목록을 확인하세요.' : error instanceof Error ? error.message : '모델 로드에 실패했습니다.');
    } finally {
      unregister(); controller.current = null; lock.current = false;
      if (mounted.current) { setBusy(false); await refresh(); }
    }
  }
  return <div className="rounded-lg border border-surface2 p-3">
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="text-sm font-semibold text-brand">원격 모델 로드 · 컨텍스트</button>
    {open && <div className="mt-3 flex flex-col gap-3">
      <p className="text-xs text-slate-400">PC와 LM Studio 서버·게이트웨이가 켜져 있어야 합니다. 다운로드된 LLM만 로드하며, 생성 중에는 변경할 수 없습니다.</p>
      {catalog.error && <p role="alert" className="text-xs text-amber-400">{catalog.error.message}</p>}
      <button type="button" disabled={busy || catalog.isFetching} onClick={() => void catalog.refetch()} className="text-left text-xs text-brand disabled:opacity-50">설치·실행 목록 새로고침</button>
      {catalog.data && <>
        <label className="text-xs text-slate-400">작업 대상
          <select aria-label="원격 모델 작업 대상" disabled={busy} value={targetId} onChange={e => {
            setTargetId(e.target.value); const next = loaded.find(item => item.id === e.target.value);
            setModelKey(next?.modelKey ?? ''); setContext(String(next?.contextLength ?? 131072)); setMessage('');
          }} className="mt-1 w-full rounded-lg bg-surface2 px-3 py-2">
            <option value="">새 모델 로드</option>
            {loaded.filter(item => item.modelKey && item.instanceId).map(item => <option key={item.id} value={item.id}>{item.name} · {item.contextLength.toLocaleString()} 토큰</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-400">다운로드된 모델
          <select aria-label="다운로드된 Local 모델" disabled={busy || !!targetId} value={modelKey} onChange={e => { setModelKey(e.target.value); setMessage(''); }} className="mt-1 w-full rounded-lg bg-surface2 px-3 py-2">
            <option value="">모델 선택</option>
            {downloaded.map(item => <option key={item.key} value={item.key}>{item.name === item.key ? item.name : `${item.name} · ${item.key}`}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-400">로드 컨텍스트 (토큰)
          <input aria-label="원격 로드 컨텍스트" type="number" min={256} max={selected?.maxContextLength ?? undefined} step={1} value={context} disabled={busy} onChange={e => setContext(e.target.value)} className="mt-1 w-full rounded-lg bg-surface2 px-3 py-2" />
        </label>
        {selected && <p className="text-xs text-slate-400">모델 지원 상한: {selected.maxContextLength?.toLocaleString() ?? '확인 불가'} 토큰. 실제 로드 길이는 적용 후 다시 확인합니다.</p>}
        <button type="button" onClick={() => void apply()} disabled={busy || catalog.isError || !selected?.maxContextLength || !Number.isSafeInteger(Number(context)) || Number(context) < 256 || Number(context) > selected.maxContextLength || !!targetId && (!target || !target.instanceId)} className="rounded-lg bg-brand px-3 py-2 text-sm text-white disabled:opacity-50">
          {busy ? `모델 준비 중 · ${Math.round(progress * 100)}%` : targetId ? '컨텍스트 적용 · 재로드' : '모델 로드'}
        </button>
      </>}
      {busy && <button type="button" onClick={() => controller.current?.abort()} className="text-left text-xs text-amber-400">모델 로드 중단</button>}
      {message && <p role="status" className="text-xs text-slate-400">{message}</p>}
    </div>}
  </div>;
}
