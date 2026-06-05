const CACHE_KEY = 'chatforme.usdKrw';
const CACHE_TTL = 60 * 60 * 1000; // 1시간

export async function getUsdToKrw(): Promise<number> {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { rate, ts } = JSON.parse(cached) as { rate: number; ts: number };
      if (Date.now() - ts < CACHE_TTL) return rate;
    }
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=KRW');
    const data = await res.json();
    const rate = data.rates?.KRW as number;
    if (rate) localStorage.setItem(CACHE_KEY, JSON.stringify({ rate, ts: Date.now() }));
    return rate ?? 1380;
  } catch {
    return 1380; // 기본 fallback
  }
}

export function toKrw(usd: number, rate: number): string {
  return '₩' + Math.round(usd * rate).toLocaleString('ko-KR');
}
