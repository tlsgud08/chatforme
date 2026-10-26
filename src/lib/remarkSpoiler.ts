import type { Extension, Resolver, Tokenizer, Token, Code } from 'micromark-util-types';
import type { Extension as MdastExtension } from 'mdast-util-from-markdown';
import type { Processor } from 'unified';

// Let micromark tokenize delimiters so escaped pipes, code and URLs retain
// their normal Markdown meaning. Resolve pairs within each inline container.
declare module 'micromark-util-types' {
  interface TokenTypeMap {
    spoilerSequence: 'spoilerSequence';
    spoiler: 'spoiler';
    spoilerText: 'spoilerText';
  }
}
declare module 'unified' {
  interface Data { micromarkExtensions?: Extension[]; fromMarkdownExtensions?: MdastExtension[]; }
}
declare module 'mdast' {
  interface RootContentMap { spoiler: PhrasingContentMap['spoiler']; }
  interface PhrasingContentMap {
    spoiler: { type: 'spoiler'; children: PhrasingContent[]; data?: { hName: string; hProperties: Record<string, string> } };
  }
}

export default function remarkSpoiler(this: Processor, options: { streaming?: boolean } = {}) {
  const resolve: Resolver = (events, context) => {
    let opener = -1;
    for (let index = 0; index < events.length; index++) {
      if (events[index][0] !== 'enter' || events[index][1].type !== 'spoilerSequence') continue;
      if (opener === -1) { opener = index; continue; }
      const opening = events[opener][1];
      const closing = events[index][1];
      const wrapper: Token = { type: 'spoiler', start: { ...opening.start }, end: { ...closing.end } };
      const body: Token = { type: 'spoilerText', start: { ...opening.end }, end: { ...closing.start } };
      let inside = events.slice(opener + 2, index);
      const resolved = new Set<Resolver>();
      for (const construct of context.parser.constructs.insideSpan.null ?? []) {
        if (construct.resolveAll && construct.resolveAll !== resolve && !resolved.has(construct.resolveAll)) {
          inside = construct.resolveAll(inside, context);
          resolved.add(construct.resolveAll);
        }
      }
      const replacement: typeof events = [
        ['enter', wrapper, context], events[opener], events[opener + 1],
        ['enter', body, context], ...inside, ['exit', body, context],
        events[index], events[index + 1], ['exit', wrapper, context],
      ];
      events.splice(opener, index - opener + 2, ...replacement);
      index = opener + replacement.length - 1;
      opener = -1;
    }
    if (opener !== -1 && options.streaming) {
      const opening = events[opener][1];
      const end = events[events.length - 1][1].end;
      const wrapper: Token = { type: 'spoiler', start: { ...opening.start }, end: { ...end } };
      events.splice(opener, 0, ['enter', wrapper, context]);
      events.push(['exit', wrapper, context]);
    } else if (opener !== -1) {
      events[opener][1].type = 'data';
    }
    return events;
  };
  const tokenize: Tokenizer = function (effects, ok, nok) {
    return first;
    function first(code: Code) {
      if (code !== 124) return nok(code);
      effects.enter('spoilerSequence');
      effects.consume(code);
      return second;
    }
    function second(code: Code) {
      if (code !== 124) return nok(code);
      effects.consume(code);
      effects.exit('spoilerSequence');
      return ok;
    }
  };
  const construct = { name: 'spoiler', tokenize, resolveAll: resolve };
  const syntax: Extension = { text: { 124: construct }, insideSpan: { null: [construct] } };
  const mdast: MdastExtension = {
    canContainEols: ['spoiler'],
    enter: {
      spoiler(token) {
        this.enter({ type: 'spoiler', children: [], data: { hName: 'span', hProperties: { 'data-spoiler': '' } } }, token);
      },
      spoilerSequence() { this.buffer(); },
    },
    exit: {
      spoiler(token) { this.exit(token); },
      spoilerSequence() { this.resume(); },
    },
  };
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(mdast);
}
