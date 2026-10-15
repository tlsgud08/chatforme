import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Render the actual JSX and invoke its event handlers with deterministic hook
// state and a recording database. No browser, network or test dependency needed.
const uri = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const compile = path => ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'), {
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const themeUri=uri(compile('src/lib/theme.ts'));
const theme=await import(themeUri);
const hooksUri=uri(`
export const useEffect=()=>{};
export const useMemo=f=>f();
export const useCallback=f=>f;
export const useRef=v=>({current:v});
export const useSyncExternalStore=(_,get)=>get();
export const useId=()=> 'test-'+globalThis.__themeHooks.index++;
export function useState(initial){
  const state=globalThis.__themeHooks,index=state.index++;
  if(!(index in state.values))state.values[index]=typeof initial==='function'?initial():initial;
  return [state.values[index],next=>{state.values[index]=typeof next==='function'?next(state.values[index]):next;}];
}`);
const writes=[];
globalThis.__themeTestDb={from(table){
  const builder={
    update(patch){writes.push({table,patch});if(table==='profiles'&&globalThis.__profileResponse)Object.assign(globalThis.__profileResponse,patch);return this;},
    insert(patch){writes.push({table,patch});return this;},
    select(){return this;},eq(){return this;},is(){return this;},or(){return this;},order(){return this;},range(){return this;},
    single(){return this;},maybeSingle(){return this;},
    then(resolve,reject){return Promise.resolve({data:table==='sessions'?globalThis.__sessionResponse:table==='profiles'?globalThis.__profileResponse:[],error:null}).then(resolve,reject);},
  };
  return builder;
}};
const baseImports={
  react:hooksUri,
  '@/lib/theme':themeUri,
  '@/lib/supabase':uri('export const supabase=globalThis.__themeTestDb;'),
  '@/lib/toast':uri('export const showToast=()=>{};'),
  '@/lib/dialog':uri('export const showConfirmDialog=async()=>true;'),
  './ThemeMenu':uri('export default function ThemeMenu(){return null;}'),
};
function componentUri(name,extra={}){
  const imports={...baseImports,...extra};
  const code=compile('src/components/'+name+'.tsx')
    .replace(/import\s+['"][^'"]+\.css['"];?/g,'')
    .replace(/from\s+(['"])([^'"]+)\1/g,(_,quote,specifier)=>`from ${JSON.stringify(imports[specifier]??import.meta.resolve(specifier))}`);
  return uri(code);
}
const editorUri=componentUri('ThemePaletteEditor');
const ThemeMenu=(await import(componentUri('ThemeMenu',{'./ThemePaletteEditor':editorUri}))).default;
const ThemePreferences=(await import(componentUri('ThemePreferences'))).default;
const WorkThemeSettings=(await import(componentUri('WorkThemeSettings'))).default;
const SessionThemeSettings=(await import(componentUri('SessionThemeSettings'))).default;
const root={dataset:{theme:'custom',themeVariant:'dark',themeMode:'single'}};
globalThis.document={documentElement:root};
globalThis.window={localStorage:{getItem:()=> 'dark'},dispatchEvent:()=>{}};
function tree(component,props,values){
  globalThis.__themeHooks={index:0,values};
  return component(props);
}
function elements(element){
  if(Array.isArray(element))return element.flatMap(elements);
  if(!element||typeof element!=='object'||!element.props)return [];
  return [element,...elements(element.props.children)];
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const single={id:'single',owner_id:'owner',work_id:null,name:'단일 테스트',description:'',dark_colors:theme.DEFAULT_DARK,light_colors:null,is_published:true};
const dual={...single,id:'dual',name:'두 버전 테스트',light_colors:theme.DEFAULT_LIGHT};

for(const selected of [single,{...single,dark_colors:null,light_colors:theme.DEFAULT_LIGHT},dual]){
  const isDual=theme.bothVariants(selected);
  const draft={name:selected.name,description:'',ai_prompt:'',...theme.createPaletteDraft(selected,'light')};
  const editing=tree(ThemeMenu,{userId:'owner'},['light',[],new Set(),{},'mine','',selected,draft,false,null]);
  const html=renderToStaticMarkup(editing);
  assert.equal(html.includes('🌙 다크 버전'),isDual);
  assert.equal(html.includes('☀️ 라이트 버전'),isDual);
  assert.equal(html.includes('🎨 테마 색상'),!isDual);
  elements(editing).find(el=>el.type==='button'&&el.props.children==='테마 저장').props.onClick();
  await flush();
  const saved=writes.findLast(write=>write.table==='themes').patch;
  assert.deepEqual({dark_colors:saved.dark_colors,light_colors:saved.light_colors},{dark_colors:selected.dark_colors,light_colors:selected.light_colors});

  const cards=tree(ThemeMenu,{userId:'owner'},['light',[selected],new Set(),{},'mine','',null,undefined,false,selected.id]);
  const cardHtml=renderToStaticMarkup(cards);
  assert.equal(cardHtml.includes('data-preview-variant="single"'),!isDual);
  assert.equal(cardHtml.includes('🌙 다크'),isDual);
  assert.equal(cardHtml.includes('☀️ 라이트'),isDual);
  elements(cards).find(el=>el.type==='button'&&el.props.children==='내 테마로 복사').props.onClick();
  await flush();
  const copied=writes.findLast(write=>write.table==='themes').patch;
  assert.equal(copied.copied_from_id,selected.id);
  assert.deepEqual({dark_colors:copied.dark_colors,light_colors:copied.light_colors},{dark_colors:selected.dark_colors,light_colors:selected.light_colors},'hub copies preserve single/dual format and exact colors');

  const pref={prefer_work_theme:true,preferred_theme_mode:'custom',preferred_theme_id:selected.id,preferred_theme_variant:'light'};
  const prefs=tree(ThemePreferences,{userId:'owner'},[pref,selected,true,false]);
  assert.equal(elements(prefs).filter(el=>el.type==='button'&&['🌙 다크','☀️ 라이트'].includes(el.props.children)).length,isDual?4:2,'only dual custom themes expose their own variant selector');
  // A dark-only theme followed by a dual theme must still choose light.
  elements(prefs).find(el=>typeof el.props.onSelect==='function').props.onSelect(selected);
  await flush();
  assert.equal('preferred_theme_variant' in writes.findLast(write=>write.table==='profiles').patch,false,'theme selection never writes over an independent variant preference');

  let workChoice;
  const work=tree(WorkThemeSettings,{userId:'owner',workId:'work',themeId:selected.id,variant:'light',onChange:(...choice)=>{workChoice=choice;}},[selected,true]);
  assert.equal(elements(work).filter(el=>el.props['aria-pressed']!==undefined).length,isDual?2:0);
  elements(work).find(el=>typeof el.props.onSelect==='function').props.onSelect(selected);
  assert.deepEqual(workChoice,[selected.id,'light']);

  const session={id:'room',work_id:'work',theme_override:'custom',theme_id:selected.id,theme_variant:'light',auto_theme_enabled:false};
  globalThis.__sessionResponse=session;
  const sidebar=tree(SessionThemeSettings,{session,userId:'owner',onUpdate:()=>{}},[selected,false,'global',false,null,'dark','dark',false]);
  assert.equal(elements(sidebar).filter(el=>el.type==='button'&&['🌙 다크','☀️ 라이트'].includes(el.props.children)).length,isDual?2:0);
  if(!isDual){
    elements(sidebar).find(el=>el.type==='button'&&el.props.children==='유동적').props.onClick();
    await flush();
    assert.equal(writes.findLast(write=>write.table==='sessions').patch.theme_variant,'light','single-to-fluid preserves the requested preference, not the palette storage slot');
  }
}

const fluid={id:'room',work_id:'work',theme_override:null,theme_id:single.id,theme_variant:'light',auto_theme_enabled:false};
const sidebar=tree(SessionThemeSettings,{session:fluid,userId:'owner',onUpdate:()=>{}},[single,false,'global',false,null,'light','light',false]);
const siteButtons=elements(sidebar).filter(el=>el.type==='button'&&['🌙 다크','☀️ 라이트'].includes(el.props.children));
assert.equal(siteButtons.find(el=>el.props.children==='☀️ 라이트').props['aria-pressed'],true,'single scene displays the site preference instead of internal dark metadata');
assert.ok(renderToStaticMarkup(sidebar).includes('현재 화면은 단일 테마입니다'));
root.dataset.themeMode='dual';
const dualSidebar=tree(SessionThemeSettings,{session:fluid,userId:'owner',onUpdate:()=>{}},[dual,false,'global',false,null,'light','light',false]);
assert.equal(elements(dualSidebar).find(el=>el.type==='button'&&el.props.children==='🌙 다크').props['aria-pressed'],true,'dual fluid scenes still show the actual applied variant');
console.log('Single theme UI: actual editor/card JSX, save payloads, global/work/room selectors and fluid preference preservation OK');

// Execute the actual sidebar variant handler with a global single palette.
// Both storage slots and both preferences must retain the account's palette.
for(const selected of [single,{...single,dark_colors:null,light_colors:theme.DEFAULT_LIGHT},dual]){
  root.dataset.themeMode=theme.bothVariants(selected)?'dual':'single';
  const pref={preferred_theme_mode:'custom',preferred_theme_id:selected.id,preferred_theme_variant:'light'};
  globalThis.__profileResponse={...pref};
  const view=tree(SessionThemeSettings,{session:fluid,userId:'owner',onUpdate:()=>{}},[selected,false,'global',false,null,'custom','light',false]);
  assert.equal(elements(view).some(el=>el.type==='input'&&el.props.type==='checkbox'),false,'automation has no toggle even for legacy OFF rooms');
  elements(view).find(el=>el.type==='button'&&el.props.children==='🌙 다크').props.onClick();
  await flush();
  assert.deepEqual(writes.findLast(write=>write.table==='profiles').patch,{preferred_theme_variant:'dark'});
  assert.equal(globalThis.__profileResponse.preferred_theme_mode,'custom');
  assert.equal(globalThis.__profileResponse.preferred_theme_id,selected.id);
  const globalChoice=theme.resolveThemeSelection(globalThis.__profileResponse,null,null,'light');
  assert.equal(globalChoice.themeId,selected.id);
  assert.deepEqual(theme.paletteFor(selected,globalChoice.variant).palette,selected.dark_colors??selected.light_colors);
  for(const mode of ['builtin','custom']){
    const fixedView=tree(SessionThemeSettings,{session:{...fluid,theme_override:mode},userId:'owner',onUpdate:()=>{}},[selected,false,'global',false,null,'custom','dark',false]);
    globalThis.__sessionResponse={...fluid,theme_override:null};
    elements(fixedView).find(el=>el.type==='button'&&el.props.children==='유동적').props.onClick();
    await flush();
    assert.equal(writes.findLast(write=>write.table==='sessions').patch.auto_theme_enabled,true);
  }
}
for(const mode of ['light','dark',null]){
  assert.deepEqual(theme.themeVariantPreferencePatch({preferred_theme_mode:mode},'dark'),{preferred_theme_mode:'dark',preferred_theme_variant:'dark'});
}
// Render every outside catalog with deliberately contaminated cached records.
const local={...single,id:'local',work_id:'work',name:'LOCAL WORK',work_shared:true};
const foreign={...local,id:'foreign',work_id:'other',name:'OTHER WORK'};
const catalog=[single,dual,local,foreign];
for(const tab of ['all','work','mine','hub','favorites']){
  const outside=tree(ThemeMenu,{userId:'owner'},['light',catalog,new Set(catalog.map(t=>t.id)),{},tab,'',null,undefined,false,null]);
  const html=renderToStaticMarkup(outside);
  assert.ok(!html.includes('LOCAL WORK')&&!html.includes('OTHER WORK'),'outside tabs never expose work themes');
  assert.ok(!elements(outside).some(el=>el.type==='button'&&el.props.children==='작품'),'outside catalog has no work tab');
  const inside=tree(ThemeMenu,{userId:'owner',workId:'work',allowWorkCreate:true},['light',catalog,new Set(),{},tab,'',null,undefined,false,null]);
  assert.ok(!renderToStaticMarkup(inside).includes('OTHER WORK'),'work editor never lists another work');
  if(tab==='all'||tab==='work')assert.ok(renderToStaticMarkup(inside).includes('LOCAL WORK'));
}
const roomPicker=tree(ThemeMenu,{userId:'owner',workId:'work',scope:'work'},['light',catalog,new Set(),{},'work','',null,undefined,false,null]);
assert.ok(renderToStaticMarkup(roomPicker).includes('LOCAL WORK'),'matching work chat still selects its work themes');
assert.ok(!renderToStaticMarkup(roomPicker).includes('OTHER WORK'));
console.log('Fluid variant handler, custom global identity, legacy OFF mode transitions and work catalog isolation OK');
