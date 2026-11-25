export type ImageCachePolicy = { maxEntries: number; maxAgeDays: number | null };
export const DEFAULT_IMAGE_CACHE_POLICY: ImageCachePolicy = { maxEntries: 1000, maxAgeDays: null };
export const IMAGE_CACHE_POLICY_MESSAGE = 'INUCHAT_IMAGE_CACHE_POLICY';
export function normalizeImageCachePolicy(value: Partial<ImageCachePolicy> | null | undefined): ImageCachePolicy {
  const entries = value?.maxEntries, days = value?.maxAgeDays;
  return {
    maxEntries: typeof entries === 'number' && Number.isInteger(entries) && entries >= 1 && entries <= 10000 ? entries : 1000,
    maxAgeDays: typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null,
  };
}
export function imageExpirationOptions(policy: ImageCachePolicy) {
  return { maxEntries: policy.maxEntries, ...(policy.maxAgeDays === null ? {} : { maxAgeSeconds: policy.maxAgeDays * 86400 }) };
}
export async function sendImageCachePolicy(policy: ImageCachePolicy): Promise<boolean> {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return false;
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = () => { clearTimeout(timer); channel.port1.close(); };
    const timer = setTimeout(() => { finish(); reject(new Error('캐시 설정 적용 응답이 없습니다.')); }, 5000);
    channel.port1.onmessage = ({ data }) => { finish(); if (data?.ok) resolve(true); else reject(new Error(data?.error || '캐시 설정 적용 실패')); };
    try { worker.postMessage({ type: IMAGE_CACHE_POLICY_MESSAGE, policy }, [channel.port2]); }
    catch (error) { finish(); reject(error); }
  });
}
