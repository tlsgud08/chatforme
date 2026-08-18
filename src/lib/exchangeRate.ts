import { useEffect, useState } from 'react';

export const FALLBACK_USD_KRW = 1400;
const CACHE_KEY = 'inuchat.exchange.usd-krw';
const CACHE_TTL = 60 * 60 * 1000;

export interface ExchangeRate {
  rate: number;
  fallback: boolean;
  updatedAt: number;
}

function cachedRate(): ExchangeRate | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as ExchangeRate | null;
    return value && Number.isFinite(value.rate) ? value : null;
  } catch { return null; }
}

export function useUsdKrwRate(): ExchangeRate {
  const [value, setValue] = useState<ExchangeRate>(() => cachedRate() ?? ({ rate: FALLBACK_USD_KRW, fallback: true, updatedAt: 0 }));

  useEffect(() => {
    const cached = cachedRate();
    if (cached && !cached.fallback && Date.now() - cached.updatedAt < CACHE_TTL) return;
    const controller = new AbortController();
    fetch('https://open.er-api.com/v6/latest/USD', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`환율 API ${response.status}`);
        return response.json() as Promise<{ result?: string; rates?: { KRW?: number } }>;
      })
      .then((data) => {
        const rate = data.rates?.KRW;
        if (data.result !== 'success' || !rate || !Number.isFinite(rate)) throw new Error('잘못된 환율 응답');
        const next = { rate, fallback: false, updatedAt: Date.now() };
        localStorage.setItem(CACHE_KEY, JSON.stringify(next));
        setValue(next);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const fallback = { rate: FALLBACK_USD_KRW, fallback: true, updatedAt: Date.now() };
        localStorage.setItem(CACHE_KEY, JSON.stringify(fallback));
        setValue(fallback);
      });
    return () => controller.abort();
  }, []);

  return value;
}

export function formatKrw(dollars: number, rate: number) {
  return `${Math.round(dollars * rate).toLocaleString('ko-KR')}원`;
}
