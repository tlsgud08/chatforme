import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import ts from 'typescript';
import postcss from 'postcss';

const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const compile = file => ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const stylesUri = uri(compile('src/lib/codeBlockStyles.ts'));
const styles = await import(stylesUri);
function component(file, overrides = {}) {
  return uri(compile(file).replace(/import\s+['"][^'"]+\.css['"];?/g, '')
    .replace(/from\s+(['"])([^'"]+)\1/g, (_, quote, name) => `from ${JSON.stringify(overrides[name] ?? import.meta.resolve(name))}`));
}
const legacyUri = component('src/components/MarkdownCodeBlock.tsx');
const { default: Legacy } = await import(legacyUri);
const { default: Status } = await import(component('src/components/StatusCodeBlock.tsx', {
  './MarkdownCodeBlock': legacyUri, '@/lib/codeBlockStyles': stylesUri,
}));

assert.deepEqual(styles.CODE_BLOCK_STYLES.map(style => style.value),
  ['basic', 'legacy', 'neon', 'corporate', 'hanji', 'scroll', 'grimoire', 'noir', 'notebook']);
for (const style of styles.CODE_BLOCK_STYLES) {
  assert.equal(styles.resolveCodeBlockStyle(null, null, { code_block_style: style.value }), style.value);
  assert.equal(styles.resolveCodeBlockStyle(null, { use_theme_code_block: false, code_block_style: style.value }, { code_block_style: 'scroll' }), style.value);
  assert.equal(styles.resolveCodeBlockStyle({ use_legacy_status: true }, { use_theme_code_block: false, code_block_style: style.value }, { code_block_style: 'scroll' }), 'legacy');
}
const fixed = { use_theme_code_block: false, code_block_style: 'noir' };
for (const theme of [{ code_block_style: 'neon' }, { code_block_style: 'hanji' }, null]) {
  assert.equal(styles.resolveCodeBlockStyle(null, fixed, theme), 'noir', 'scene changes never replace the room choice');
}
assert.equal(styles.resolveCodeBlockStyle(null, { ...fixed, use_theme_code_block: true }, { code_block_style: 'hanji' }), 'hanji');
assert.equal(styles.resolveCodeBlockStyle(null, null, { code_block_style: 'space' }), 'basic');
assert.equal(styles.resolveCodeBlockStyle(null, null, null), 'basic');

const raw = '  첫 줄\n[상태] **위독** · *속삭임*\n<script>실행하지 않는 문자</script>\n';
const child = h('code', { className: 'language-기록', node: { data: { meta: '제목' } } }, raw);
const legacy = renderToStaticMarkup(h(Legacy, null, child));
assert.equal(renderToStaticMarkup(h(Status, { style: 'legacy' }, child)), legacy, 'Legacy must be the exact existing rendered component');
assert.ok(legacy.includes('bg-[#232220]') && legacy.includes('bg-[#45443f]') && legacy.includes('text-[#dedde7]'));
assert.equal(renderToStaticMarkup(h(Status, {style:'legacy',mutedTextClassName:'chat-user-muted-text'}, child)),
  renderToStaticMarkup(h(Legacy, {mutedTextClassName:'chat-user-muted-text'}, child)), 'Legacy user emphasis stays exactly unchanged');
for (const { value } of styles.CODE_BLOCK_STYLES.filter(style => style.value !== 'legacy')) {
  const html = renderToStaticMarkup(h(Status, { style: value }, child));
  assert.ok(html.includes(`status-code-frame cf-${value}`));
  assert.ok(html.includes('기록 제목'), value + ': the original fence info becomes the title');
  assert.ok(html.includes('  첫 줄\n') && html.includes('<strong class="font-bold">위독</strong>'));
  assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>'));
  const userHtml=renderToStaticMarkup(h(Status,{style:value,mutedTextClassName:'chat-user-muted-text'},child));
  assert.ok(userHtml.includes('class="cf-user-muted-text"')&&!userHtml.includes('class="chat-user-muted-text"'),
    'themed user emphasis follows its block foreground in both light and dark palettes');
  if (value === 'basic') assert.ok(!html.includes('cf-fold') && !html.includes('cf-foot'));
  if (value === 'hanji') assert.ok(!html.includes('cf-head-tag') && html.includes('記'));
  if (value === 'noir') assert.ok(html.includes('TOP SECRET') && !html.includes('극비'));
  if (value === 'corporate') assert.ok(html.includes('INTERNAL RECORD') && html.includes('機密'));
  if (value === 'neon') assert.ok(html.includes('STATUS TERMINAL') && html.includes('LOCAL'));
  const untitled = renderToStaticMarkup(h(Status, { style: value }, h('code', null, raw)));
  assert.ok(!untitled.includes('class="cf-head"'), 'no invented title for an untitled fence');
}
const markdown = '```인물 정보\n  [상태] **평온**\n```';
const html = renderToStaticMarkup(h(ReactMarkdown, {
  components: { pre: ({ children }) => h(Status, { style: 'neon' }, children),
    code: ({ children }) => h('code', { className: 'inline-test' }, children) },
}, markdown));
assert.ok(html.includes('인물 정보'), 'the actual Markdown pipeline retains a multiword title');
assert.ok(html.includes('  [상태] <strong class="font-bold">평온</strong>'));

// The corporate decoration follows live theme accents; body text and every
// other status style retain the common foreground/secondary-color variables.
const css=postcss.parse(readFileSync(new URL('../src/components/StatusCodeBlock.css',import.meta.url),'utf8'));
const accentOverrides=[];
css.walkDecls('--cf-accent',declaration=>accentOverrides.push([declaration.parent.selector,declaration.value]));
assert.deepEqual(accentOverrides,[
  ['.status-code-frame','var(--secondary-text, rgb(var(--color-brand)))'],
  ['.status-code-frame.cf-corporate','rgb(var(--color-brand))'],
]);
const footer=[];css.walkRules('.status-code-frame.cf-corporate .cf-foot',rule=>rule.walkDecls('color',declaration=>footer.push(declaration.value)));
assert.deepEqual(footer,['var(--cf-accent)'],'both footer spans, including the barcode, inherit the corporate theme accent');
css.walkRules(rule=>{if(rule.selector.includes('.cf-corporate'))rule.walkDecls(declaration=>{
  assert(!['--cf-fg','--cf-secondary'].includes(declaration.prop),'corporate decoration never replaces body text colors');
});});

globalThis.document = { documentElement: { dataset: {} } };
let notifications = 0;
const stop = styles.subscribeCodeBlockStyle(() => notifications++);
styles.applyCodeBlockStyle('neon');
styles.applyCodeBlockStyle('neon');
assert.equal(notifications, 1);
assert.equal(styles.appliedCodeBlockStyle(), 'neon');
styles.applyCodeBlockStyle('legacy');
assert.equal(notifications, 2);
stop();
styles.applyCodeBlockStyle('basic');
assert.equal(notifications, 2);
console.log('Status blocks: exact unchanged Legacy, nine ordered styles, real Markdown, safe emphasis, palette-independent priority and deduplicated live updates passed.');
