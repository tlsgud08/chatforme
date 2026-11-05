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
  const key = ['work-display-stats', undefined, 'fixture', true];
  const render = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(AuthProvider, null, React.createElement(Stats, { workId: 'fixture' }))));
  client.setQueryData(['work-display-stats',undefined,'fixture',false],{sessions:12,messages:1234});
  let hidden = render();
  assert(hidden.includes('12세션') && hidden.includes('1,234턴'),'counts remain visible with credits disabled');
  assert(!hidden.includes('작품 총 사용 금액'),'credit display defaults off');
  values.set('inuchat.workCreditsEnabled', '1');
  client.setQueryData(key, { sessions: 12, messages: 1234, dollars: 1.25 });
  let html = render();
  assert(html.includes('1,234턴') && html.includes('$1.250000'));
  assert(html.includes('12세션') && html.includes('1,234턴'),'detail distinguishes rooms from user turns');
  assert.equal((html.match(/<svg/g) ?? []).length, 3, 'separate session, turn and coin SVG icons');
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
