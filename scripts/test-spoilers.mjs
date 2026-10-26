import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
const js = ts.transpileModule(readFileSync(new URL('../src/lib/remarkSpoiler.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { default: spoiler } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const parse = (text, streaming = false) => unified().use(remarkParse).use(remarkGfm).use(spoiler, { streaming }).parse(text);
const nodes = (tree, type) => [ ...(tree.type === type ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, type)) ];
assert.equal(nodes(parse('일반 ||비밀|| 끝 ||두 번째||'), 'spoiler').length, 2);
const formatted = nodes(parse('||**굵게** *기울임* [링크](https://example.com)||'), 'spoiler')[0];
assert.equal(nodes(formatted, 'strong').length, 1);
assert.equal(nodes(formatted, 'emphasis').length, 1);
assert.equal(nodes(formatted, 'link').length, 1);
assert.equal(nodes(parse('`||코드||`\n\n```\n||블록||\n```'), 'spoiler').length, 0);
assert.equal(nodes(parse('||`a || b` 비밀||'), 'spoiler').length, 1);
assert.equal(nodes(parse('\\|\\|일반\\|\\|'), 'spoiler').length, 0);
assert.equal(nodes(parse('&#124;&#124;일반&#124;&#124;'), 'spoiler').length, 0);
assert.equal(nodes(parse('||첫 줄\n다음 줄||'), 'spoiler').length, 1);
assert.equal(nodes(parse('||아직 열림'), 'spoiler').length, 0);
assert.equal(nodes(parse('||아직 열림', true), 'spoiler').length, 1);
assert.equal(nodes(parse('||완성||', true), 'spoiler').length, 1);
assert.equal(nodes(parse('||'), 'spoiler').length, 0);
console.log('Spoilers: pairs, formatting, links, code, escapes, entities, newlines and partial streams OK');
