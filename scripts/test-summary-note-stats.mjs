import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { default: Stats } = await server.ssrLoadModule('/src/components/SummaryNoteStats.tsx');
  const { summaryNarrativeConfig } = await server.ssrLoadModule('/src/lib/summaryNarrative.ts');
  const exchange = { rate: 1400, fallback: false, updatedAt: 1 };
  const archive = content => `[주요인물]\n${'인물정보'.repeat(1000)}\n[핵심 서사 및 맥락]\n${content}\n[종합 상황]\n${'다른섹션'.repeat(1000)}`;
  const version = { id: 'note', content: archive('가'.repeat(8200)), narrative_target_chars: '10000', narrative_target_enabled: true, cost: 0.0123, output_tokens: 9999 };
  const render = (value = version, krw = false) => renderToStaticMarkup(React.createElement(Stats, { version: value, showCostKrw: krw, exchange }));
  let html = render();
  assert(html.includes('사용 $0.012300') && html.includes('총 출력 9,999토큰'));
  assert(html.includes('목표 10,000자') && html.includes('핵심 서사 8,200자') && html.includes('82% 달성'));
  assert(html.includes('추론 토큰') && html.includes('편집 후 본문의 토큰 수는 아닙니다'), 'API output counts are not presented as a re-tokenized body');
  assert(render(version, true).includes('17원'), 'cost uses the existing currency selection and exchange rate');
  html = render({ ...version, content: archive('나'.repeat(5000)) });
  assert(html.includes('50% 달성') && html.includes('목표 10,000자') && html.includes('총 출력 9,999토큰') && html.includes('$0.012300'), 'edits recalculate characters while preserving the generation goal, cost and API usage');
  html = render({ ...version, narrative_target_chars: null, narrative_target_enabled: null });
  assert(html.includes('목표 기록 없음') && html.includes('8,200자') && !html.includes('% 달성'), 'historical notes never borrow today\'s goal');
  assert(render({ ...version, narrative_target_enabled: false }).includes('목표 미적용'));
  html = render({ ...version, content: 'missing section' });
  assert(html.includes('분량 확인 불가') && !html.includes('% 달성'));
  assert(render({ ...version, output_tokens: null }).includes('출력 토큰 확인 불가'));
  assert(render({ ...version, output_tokens: 0 }).includes('총 출력 0토큰'));
  html = render({ ...version, cost: 0, output_tokens: 0, finish_reason: 'user_stop', native_finish_reason: 'client_abort_usage_unreported' });
  assert(html.includes('사용 확인 불가') && html.includes('출력 토큰 확인 불가'), 'a manually stopped stream without usage is never advertised as free');
  html = render({ ...version, cost: 0, output_tokens: 0, finish_reason: 'stream_error', native_finish_reason: 'client_stream_interrupted_usage_unreported' });
  assert(html.includes('사용 확인 불가') && html.includes('출력 토큰 확인 불가'), 'an interrupted connection without usage is unknown too');
  assert.equal(summaryNarrativeConfig({}, {}).target, '10000');

  const page = ts.createSourceFile('menu.tsx', readFileSync(new URL('../src/components/SessionMenu.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let adjacent = false;
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(page) === 'SummaryNoteStats') {
      const source = node.parent.getText(page);
      adjacent = source.includes('>편집</button>') && source.includes('>삭제</button>') && source.includes('inu-item-actions');
    }
    ts.forEachChild(node, visit);
  }
  visit(page); assert(adjacent, 'usage and character statistics are placed beside edit/delete');
  console.log('Summary note stats: exact Korean characters, historical goals, edited notes, cost currency, actual total output tokens, unknown/zero values and edit/delete placement passed.');
} finally { await server.close(); }
