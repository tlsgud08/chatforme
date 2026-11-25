import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { imageCachePolicyKey, useImageCachePolicy } from '@/hooks/useImageCachePolicy';
import { supabase } from '@/lib/supabase';
import { clearImageCaches, readImageCacheUsage } from '@/lib/imageCache';
import { sendImageCachePolicy } from '@/lib/imageCachePolicy';
import { loadInterfaceDesign, subscribeInterfaceDesign } from '@/lib/interfacePreference';
import InterfaceIcon from './InterfaceIcon';
import Toggle from './Toggle';
const bytes = (value: number | null | undefined) => value == null ? '확인 불가' : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export default function ImageCacheSettings({ active }: { active: boolean }) {
  const { user } = useAuth();
  const client = useQueryClient();
  const design = useSyncExternalStore(subscribeInterfaceDesign, loadInterfaceDesign, () => 'modern' as const);
  const visible = active || design === 'legacy';
  const policy = useImageCachePolicy(user?.id);
  const stats = useQuery({ queryKey: ['image-cache-usage'], queryFn: readImageCacheUsage, enabled: visible, staleTime: 0, refetchOnWindowFocus: true });
  const [entries, setEntries] = useState('1000');
  const [days, setDays] = useState('30');
  const [unlimited, setUnlimited] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!policy.data || dirty) return;
    setEntries(String(policy.data.maxEntries)); setUnlimited(policy.data.maxAgeDays === null);
    setDays(String(policy.data.maxAgeDays ?? 30));
  }, [policy.data, dirty]);
  const count = Number(entries), age = Number(days);
  const valid = /^\d+$/.test(entries) && count >= 1 && count <= 10000 && (unlimited || /^\d+$/.test(days) && age >= 1 && age <= 3650);
  async function save() {
    if (!valid || !user || busy || !policy.data) return;
    setBusy(true); setMessage('');
    try {
      const next = { maxEntries: count, maxAgeDays: unlimited ? null : age };
      const { data, error } = await supabase.from('profiles').update({ image_cache_max_entries: next.maxEntries, image_cache_max_age_days: next.maxAgeDays }).eq('id', user.id).select('id').single();
      if (error || !data) throw error ?? new Error('계정 설정을 찾을 수 없습니다.');
      client.setQueryData(imageCachePolicyKey(user.id), next); setDirty(false);
      let applied = false;
      try { applied = await sendImageCachePolicy(next); } catch { /* Older workers apply after a normal application restart. */ }
      setMessage(applied ? '저장했습니다.' : '계정에 저장했습니다. 모든 Inuchat 탭을 닫고 다시 열면 적용됩니다.');
      await stats.refetch();
    } catch (error) { setMessage('저장 실패: ' + (error as { message: string }).message); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await clearImageCaches(); await stats.refetch(); setMessage('이미지 캐시를 삭제했습니다.'); }
    catch { setMessage('캐시 삭제 실패. 브라우저의 저장소 접근을 확인해 주세요.'); }
    finally { setBusy(false); }
  }
  return <section data-settings-section="cache" aria-labelledby="image-cache-heading">
    <h2 id="image-cache-heading" className="mb-3 flex items-center gap-2 font-semibold text-white"><InterfaceIcon name="imageCache" />이미지 캐시</h2>
    {policy.isError && <p role="alert" className="mb-3 text-sm text-amber-400">계정 설정을 불러오지 못했습니다. <button type="button" onClick={() => void policy.refetch()} className="underline">다시 불러오기</button></p>}
    <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-4 rounded-xl bg-surface p-4">
      <label className="block text-sm text-slate-300">채팅 이미지 최대 개수<input type="number" inputMode="numeric" min={1} max={10000} step={1} disabled={busy || !policy.data} value={entries} onChange={event => { setEntries(event.target.value); setDirty(true); }} className="mt-2 w-full rounded-lg bg-surface2 px-3 py-2.5 text-base text-white outline-none focus:ring-1 focus:ring-brand" /></label>
      <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-sm text-slate-300"><InterfaceIcon name="history" />보관 기간 무제한</span><Toggle aria-label="이미지 캐시 보관 기간 무제한" disabled={busy || !policy.data} checked={unlimited} onChange={value => { setUnlimited(value); setDirty(true); }} /></div>
      {!unlimited && <label className="block text-sm text-slate-300">미사용 보관 기간 (일)<input type="number" inputMode="numeric" min={1} max={3650} step={1} disabled={busy || !policy.data} value={days} onChange={event => { setDays(event.target.value); setDirty(true); }} className="mt-2 w-full rounded-lg bg-surface2 px-3 py-2.5 text-base text-white outline-none focus:ring-1 focus:ring-brand" /></label>}
      {!valid && <p role="alert" className="text-sm text-amber-400">개수는 1~10,000개, 기간은 1~3,650일로 입력해 주세요.</p>}
      <button type="submit" disabled={!valid || busy || !policy.data} className="w-full rounded-lg bg-brand py-2.5 text-sm font-semibold text-white disabled:opacity-40">{busy ? '처리 중…' : '계정에 저장'}</button>
    </form>
    <div className="mt-4 rounded-xl bg-surface p-4" aria-label="이 기기 캐시 사용량">
      <div className="mb-3 flex items-center justify-between"><h3 className="flex items-center gap-2 text-sm font-semibold text-white"><InterfaceIcon name="imageCache" />이 기기 사용량</h3><button type="button" aria-label="캐시 사용량 새로고침" disabled={stats.isFetching || busy} onClick={() => void stats.refetch()} className="p-2 text-slate-400 disabled:opacity-40"><InterfaceIcon name="reroll" /></button></div>
      {stats.isFetching && !stats.data ? <p role="status" className="text-sm text-slate-400">불러오는 중…</p> : <dl className="space-y-2 text-sm text-slate-300">
        <div className="flex justify-between gap-3"><dt>채팅 이미지</dt><dd>{stats.data?.chatImages ?? '확인 불가'} / {policy.data?.maxEntries ?? '…'}개</dd></div>
        <div className="flex justify-between gap-3"><dt>작품 썸네일</dt><dd>{stats.data?.thumbnails ?? '확인 불가'} / 100개</dd></div>
        <div className="flex justify-between gap-3"><dt>사이트 저장량 (추정)</dt><dd>{bytes(stats.data?.usage)}</dd></div>
        <div className="flex justify-between gap-3"><dt>브라우저 허용량 (추정)</dt><dd>{bytes(stats.data?.quota)}</dd></div>
      </dl>}
      <p className="mt-3 text-xs text-slate-500">저장량은 캐시 외 사이트 데이터를 포함하며, 브라우저 계산 방식에 따라 실제 파일 용량과 다를 수 있어요.</p>
    </div>
    <button type="button" disabled={busy} onClick={() => void clear()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-surface2 py-2.5 text-sm font-semibold text-white disabled:opacity-40"><InterfaceIcon name="delete" />이미지 캐시 삭제</button>
    <p role="status" className="mt-2 text-sm text-slate-400">{message}</p>
  </section>;
}
