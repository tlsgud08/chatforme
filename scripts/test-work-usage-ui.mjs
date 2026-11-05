import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

const values = new Map();
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { default: Stats } = await server.ssrLoadModule('/src/components/WorkUsageStats.tsx');
  const { AuthProvider } = await server.ssrLoadModule('/src/hooks/useAuth.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ['work-usage', undefined, 'fixture'];
  const render = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(AuthProvider, null, React.createElement(Stats, { workId: 'fixture' }))));
  client.setQueryData(key, { turns: 1234, dollars: 1.25 });
  let html = render();
  assert(html.includes('1,234턴') && html.includes('$1.250000'));
  assert.equal((html.match(/<svg/g) ?? []).length, 2, 'chat and coin use SVG icons');
  values.set('inuchat.showCostKrw', '1');
  values.set('inuchat.exchange.usd-krw', JSON.stringify({ rate: 1400, fallback: false, updatedAt: Date.now() }));
  html = render();
  assert(html.includes('1,750원') && !html.includes('$1.250000'), 'uses existing global currency and exchange-rate cache');
  client.removeQueries({ queryKey: key });
  html = render();
  assert(html.includes('…') && !html.includes('0턴'), 'loading is never reported as zero');
  await assert.rejects(client.fetchQuery({ queryKey: key, queryFn: () => { throw new Error('offline'); } }));
  html = render();
  assert(html.includes('통계 다시 불러오기') && html.includes('—') && !html.includes('0턴'), 'failure preserves the distinction from zero');
  client.clear();
  console.log('Work usage UI: SVG icons, USD/KRW, cached rate, loading and retry state passed');
} finally { await server.close(); delete globalThis.localStorage; }
