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
const directivesUri=uri(compile('src/lib/themeDirectives.ts').replace("'./theme'",JSON.stringify(themeUri)));
const directives=await import(directivesUri);
const hooksUri=uri(`
export const useEffect=f=>{globalThis.__capturedEffects?.push(f);};
export const useMemo=f=>f();
export const useCallback=f=>f;
export const useRef=v=>({current:v});
export const useSyncExternalStore=(_,get)=>get();
export const useId=()=> 'test-'+globalThis.__themeHooks.index++;
export function useState(initial){
  const state=globalThis.__themeHooks,index=state.index++;
  if(!(index in state.values))state.values[index]=typeof initial==='function'?initial():initial;
  return [state.values[index],next=>{
    const update=()=>{state.values[index]=typeof next==='function'?next(state.values[index]):next;};
    if(state.pending)state.pending.push(update);else update();
  }];
}`);
const writes=[];
globalThis.__themeTestDb={from(table){
  const builder={
    update(patch){this.patch=patch;writes.push({table,patch});if(table==='profiles'&&globalThis.__profileResponse)Object.assign(globalThis.__profileResponse,patch);return this;},
    insert(patch){writes.push({table,patch});return this;},
    select(){return this;},eq(key,value){(this.filters??={})[key]=value;return this;},is(){return this;},or(){return this;},order(){return this;},range(){return this;},
    single(){return this;},maybeSingle(){return this;},
    then(resolve,reject){return Promise.resolve({data:table==='sessions'?{...globalThis.__sessionResponse,...this.patch}:table==='profiles'?globalThis.__profileResponse:table==='themes'?globalThis.__themeById?.[this.filters?.id]??globalThis.__themeResponse??[]:table==='works'?globalThis.__workResponse??[]:[],error:null}).then(resolve,reject);},
  };
  return builder;
}};
const baseImports={
  react:hooksUri,
  '@/lib/theme':themeUri,
  '@/lib/themeDirectives':directivesUri,
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
const toggleUri=componentUri('Toggle');
baseImports['./Toggle']=toggleUri;
const Toggle=(await import(toggleUri)).default;
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
  assert.equal(elements(prefs).filter(el=>el.type==='button'&&['🌙 다크','☀️ 라이트'].includes(el.props.children)).length,4,'single and dual global custom themes both expose the shared preference');
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
    assert.equal(writes.findLast(write=>write.table==='sessions').patch.theme_variant,'dark','single-to-fluid uses the shared preference, not a legacy room variant');
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
  assert.equal(elements(view).find(el=>el.props['aria-label']==='다크 버전을 밤 테마로 사용').props.checked,false,'day/night defaults OFF even for legacy auto-OFF rooms');
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

// Global custom preference → sidebar, then sidebar → global settings.
for(const selected of [single,{...single,dark_colors:null,light_colors:theme.DEFAULT_LIGHT},dual]){
  root.dataset.themeMode=theme.bothVariants(selected)?'dual':'single';
  root.dataset.themeVariant='dark';
  const pref={prefer_work_theme:true,preferred_theme_mode:'custom',preferred_theme_id:selected.id,preferred_theme_variant:'light'};
  globalThis.__profileResponse={...pref};
  const globalView=tree(ThemePreferences,{userId:'owner'},[pref,selected,false,false]);
  const group=elements(globalView).find(el=>el.props['aria-label']==='라이트·다크 선호');
  elements(group).find(el=>el.type==='button'&&el.props.children==='🌙 다크').props.onClick();
  await flush();
  assert.deepEqual(writes.findLast(write=>write.table==='profiles').patch,{preferred_theme_variant:'dark'});
  assert.equal(globalThis.__profileResponse.preferred_theme_mode,'custom');
  assert.equal(globalThis.__profileResponse.preferred_theme_id,selected.id);
  const sidebarView=tree(SessionThemeSettings,{session:{...fluid,theme_variant:'dark'},userId:'owner',onUpdate:()=>{}},[selected,false,'global',false,null,'custom','dark',false]);
  assert.equal(elements(sidebarView).find(el=>el.type==='button'&&el.props.children==='🌙 다크').props['aria-pressed'],true);
  elements(sidebarView).find(el=>el.type==='button'&&el.props.children==='☀️ 라이트').props.onClick();
  await flush();
  assert.equal(globalThis.__profileResponse.preferred_theme_variant,'light');
  const refreshedGlobal=tree(ThemePreferences,{userId:'owner'},[{...globalThis.__profileResponse},selected,false,false]);
  const refreshedGroup=elements(refreshedGlobal).find(el=>el.props['aria-label']==='라이트·다크 선호');
  assert.equal(elements(refreshedGroup).find(el=>el.type==='button'&&el.props.children==='☀️ 라이트').props['aria-pressed'],true);
  if(!theme.bothVariants(selected)){
    const choice=theme.resolveThemeSelection(globalThis.__profileResponse,null,null,'dark');
    assert.equal(choice.themeId,selected.id);
    assert.deepEqual(theme.paletteFor(selected,choice.variant).palette,selected.dark_colors??selected.light_colors);
  }
}
console.log('Global custom preference controls: both single slots, dual themes and bidirectional sidebar preference payloads OK');

// Manual single → dual, builtin and remembered dual choices use the shared
// preference even when legacy room state has the opposite storage variant.
for(const preferred of ['light','dark']){
  const legacy=preferred==='light'?'dark':'light';
  root.dataset.themeMode='single';root.dataset.themeVariant=legacy;root.dataset.themePreferredVariant=preferred;
  const oldSession={...fluid,theme_override:'custom',theme_variant:legacy};
  globalThis.__sessionResponse=oldSession;
  const picker=tree(SessionThemeSettings,{session:oldSession,userId:'owner',onUpdate:()=>{}},[single,true,'global',false,null,'custom',preferred,false]);
  elements(picker).find(el=>typeof el.props.onSelect==='function').props.onSelect(dual);
  await flush();
  assert.equal(writes.findLast(write=>write.table==='sessions').patch.theme_variant,preferred);
  for(const mode of ['기본 테마','유동적','커스텀']){
    const last={id:dual.id,variant:legacy,theme:dual};
    const view=tree(SessionThemeSettings,{session:oldSession,userId:'owner',onUpdate:()=>{}},[single,false,'global',false,last,'custom',preferred,false]);
    elements(view).find(el=>el.type==='button'&&el.props.children===mode).props.onClick();
    await flush();
    assert.equal(writes.findLast(write=>write.table==='sessions').patch.theme_variant,preferred);
  }
}
console.log('Manual single transitions: shared preference overrides obsolete room metadata OK');

// Invoke real palette field handlers in every supported editor variant.
const ThemePaletteEditor=(await import(editorUri)).default;
const list='112233;#ffffff;223344;#aabbcc; 556677';
for(const variant of ['single','light','dark']){
  const palette={...theme.DEFAULT_DARK,secondaryText:'#cccccc',softenSecondaryText:false,secondaryTextOpacity:35};
  let changes=[];
  const editor=tree(ThemePaletteEditor,{variant,palette,onChange:p=>changes.push(p)},[]);
  const fields=elements(editor).find(el=>typeof el.type==='function');
  const rendered=tree(fields.type,fields.props,[]);
  const mainInput=elements(rendered).find(el=>el.props['aria-label']==='메인색 HEX');
  mainInput.props.onChange({target:{value:'abcdef'}});
  assert.equal(changes.at(-1).main,'#abcdef');
  assert.equal(changes.at(-1).accent,palette.accent);
  mainInput.props.onChange({target:{value:''}});
  assert.equal(changes.at(-1).main,'','partial edits remain editable');
  const bulk=elements(rendered).find(el=>el.type==='textarea'&&el.props['aria-label']==='색상 5개 일괄 입력');
  bulk.props.onChange({target:{value:list}});
  assert.deepEqual(changes.at(-1),{...palette,accent:'#112233',accentText:'#ffffff',main:'#223344',mainText:'#aabbcc',secondaryText:'#556677'});
  const count=changes.length;
  for(const invalid of ['#123456;#ffffff','#123456;#ffffff;#223344;#aabbcc;bad','112233;ffffff;223344;aabbcc;556677;abcdef']){
    bulk.props.onChange({target:{value:invalid}});
    assert.equal(changes.length,count,'invalid bulk input cannot partially overwrite palette');
  }
}
console.log('Palette field handlers: automatic hashes, atomic five-color paste, both variants and opacity preservation OK');

// Execute ThemeManager's real asynchronous effect, including a legacy single
// palette whose storage slot disagrees with the preference. Then initialize the
// real catalog from the applied metadata rather than a supplied variant state.
const ThemeManager=(await import(componentUri('ThemeManager',{
  'react-router-dom':uri('export const useLocation=()=>globalThis.__themeLocation;'),
  '@/hooks/useAuth':uri('export const useAuth=()=>({user:{id:"owner"}});'),
  '@/lib/inFlight':uri('export const shareInFlight=(_,read)=>read(); export const invalidateInFlight=()=>{};'),
}))).default;
const properties=new Map();
root.style={getPropertyValue:key=>properties.get(key)??'',setProperty:(key,v)=>properties.set(key,v),removeProperty:key=>properties.delete(key)};
globalThis.window={localStorage:{getItem:()=> 'dark',setItem:()=>{}},dispatchEvent:()=>{},addEventListener:()=>{},removeEventListener:()=>{}};
globalThis.document.addEventListener=()=>{};
globalThis.document.removeEventListener=()=>{};
for(const [selected,preference,fixedVariant] of [[single,'light',null],[{...single,dark_colors:null,light_colors:theme.DEFAULT_LIGHT},'dark',null],[dual,'light','dark']]){
  globalThis.__capturedEffects=[];
  globalThis.__profileResponse={prefer_work_theme:false,preferred_theme_mode:'custom',preferred_theme_id:selected.id,preferred_theme_variant:preference};
  globalThis.__themeResponse=selected;
  globalThis.__themeLocation={pathname:fixedVariant?'/chat/30000000-0000-0000-0000-000000000001':'/settings'};
  globalThis.__sessionResponse={work_id:'work',theme_override:'custom',theme_id:selected.id,theme_variant:fixedVariant};
  tree(ThemeManager,{},[]);
  const cleanup=globalThis.__capturedEffects[0]();
  await flush();
  assert.equal(root.dataset.themePreferredVariant,preference);
  assert.equal(root.dataset.themeVariant,fixedVariant??preference,'single slots never replace the preferred variant; fixed dual choices remain fixed');
  assert.equal(properties.get('--page-bg'),(selected.dark_colors??selected.light_colors).main);
  const values=[];
  values[1]=[dual]; values[2]=new Set();values[3]={};values[4]='mine';values[5]='';values[6]=null;
  const cards=tree(ThemeMenu,{userId:'owner'},values);
  const card=elements(cards).find(el=>el.type==='article');
  assert.equal(card.props['data-preview-variant'],preference);
  assert.equal(card.props.style.backgroundColor,dual[preference+'_colors'].main);
  cleanup();
}
delete globalThis.__capturedEffects;
delete globalThis.__themeResponse;
console.log('Actual ThemeManager → catalog: legacy single slots normalized to preference; fixed dual mode preserved OK');

// Night-mode settings use the shared LIGHT preference even while the actual
// scene is dark. Enabling, disabling and a concurrent preference edit execute
// real sidebar handlers, including the fresh profile guard.
root.dataset.theme='custom';root.dataset.themeMode='dual';root.dataset.themeVariant='dark';root.dataset.themePreferredVariant='light';
const dayTheme={...dual,work_id:'work',day_night_enabled:true};
const dayRoom={...fluid,theme_id:dayTheme.id,theme_variant:'light',theme_day_night_enabled:false,theme_period:null};
globalThis.__sessionResponse=dayRoom;
globalThis.__profileResponse={preferred_theme_mode:'custom',preferred_theme_variant:'light'};
let changedRoom;
const dayView=tree(SessionThemeSettings,{session:dayRoom,userId:'owner',onUpdate:p=>changedRoom=p},[dayTheme,false,'global',false,null,'custom','light',false]);
const dayToggle=elements(dayView).find(el=>el.props['aria-label']==='다크 버전을 밤 테마로 사용');
assert.equal(dayToggle.props.checked,false);assert.equal(dayToggle.props.disabled,false);
dayToggle.props.onChange(true);await flush();
assert.equal(changedRoom.theme_day_night_enabled,true);assert.equal(changedRoom.theme_period,null);
const nightRoom={...changedRoom,theme_period:'night'};
globalThis.__sessionResponse=nightRoom;
const nightView=tree(SessionThemeSettings,{session:nightRoom,userId:'owner',onUpdate:p=>changedRoom=p},[dayTheme,false,'global',false,null,'custom','light',false]);
assert.equal(elements(nightView).find(el=>el.type==='button'&&el.props.children==='☀️ 라이트').props['aria-pressed'],true,'night display never changes light preference indication');
elements(nightView).find(el=>el.props['aria-label']==='다크 버전을 밤 테마로 사용').props.onChange(false);await flush();
assert.equal(changedRoom.theme_day_night_enabled,false);assert.equal(changedRoom.theme_period,null);
const staleView=tree(SessionThemeSettings,{session:dayRoom,userId:'owner',onUpdate:()=>{}},[dayTheme,false,'global',false,null,'custom','light',false]);
globalThis.__profileResponse.preferred_theme_variant='dark';
const writesBefore=writes.length;
elements(staleView).find(el=>el.props['aria-label']==='다크 버전을 밤 테마로 사용').props.onChange(true);await flush();
assert.equal(writes.length,writesBefore,'a concurrent dark preference blocks enabling the option');
const darkView=tree(SessionThemeSettings,{session:dayRoom,userId:'owner',onUpdate:()=>{}},[dayTheme,false,'global',false,null,'custom','dark',false]);
assert.equal(elements(darkView).find(el=>el.props['aria-label']==='다크 버전을 밤 테마로 사용'),undefined);
for(const mode of ['dark','custom',null]){
 for(const enabled of [false,true]){
  const hidden=tree(SessionThemeSettings,{session:{...nightRoom,theme_day_night_enabled:enabled},userId:'owner',onUpdate:()=>{}},[dayTheme,false,'global',false,null,mode,'dark',false]);
  assert.equal(elements(hidden).find(el=>el.props['aria-label']==='다크 버전을 밤 테마로 사용'),undefined,'dark or unknown preferences never show the time toggle, even with a stale ON value');
  assert.ok(!renderToStaticMarkup(hidden).includes('라이트 선호의 유동적 모드에서만 작동합니다.'));
 }
}

for(const mode of ['single','dual']){
 const draft={name:'정원',description:'',ai_prompt:'정원 조건',day_night_enabled:false,...theme.createPaletteDraft(dayTheme,'light'),mode};
 const values=['light',[],new Set(),{},'work','',dayTheme,draft,false,null];
 const editView=tree(ThemeMenu,{userId:'owner',workId:'work',allowWorkCreate:true},values);
 const toggle=elements(editView).find(el=>el.props['aria-label']==='시간 전환을 켰을 때만 사용');
 assert.equal(toggle.props.disabled,false);assert.equal(toggle.props.checked,false);
 toggle.props.onChange({target:{checked:true},currentTarget:{checked:true}});
 const edited=tree(ThemeMenu,{userId:'owner',workId:'work',allowWorkCreate:true},values);
 elements(edited).find(el=>el.type==='button'&&el.props.children==='테마 저장').props.onClick();await flush();
 assert.equal(writes.findLast(w=>w.table==='themes').patch.day_night_enabled,true);
 assert.equal(values[7].mode,mode);
}
console.log('Day/night UI: default OFF, light-only live guard, night preference display, OFF reset and work dual save payloads OK');

// A new or legacy single work theme must be able to opt into time switching
// directly. The condition must never change its palette mode or add colors.
for(const selected of [null,{...single,work_id:'work'},{...single,work_id:'work',dark_colors:null,light_colors:theme.DEFAULT_LIGHT},dayTheme]){
 for(const shared of [false,true]){
  const props={userId:'owner',workId:'work',scope:'work',allowWorkCreate:shared};
  const draft={name:'정원',description:'',ai_prompt:'정원 조건',day_night_enabled:false,...theme.createPaletteDraft(selected,'light')};
  const values=['light',[],new Set(),{},'work','',selected??'new',draft,false,null];
  let view=tree(ThemeMenu,props,values);
  let toggle=elements(view).find(el=>el.props['aria-label']==='시간 전환을 켰을 때만 사용');
  assert.equal(toggle.props.disabled,false,'single work themes can enable time switching without a separate mode change');
  // React may run a functional updater after the controlled DOM input has
  // been restored. The handler must capture checked before queuing the update.
  const target={checked:true},event={target,currentTarget:target};
  globalThis.__themeHooks.pending=[];
  toggle.props.onChange(event);
  target.checked=false;event.currentTarget=null;
  globalThis.__themeHooks.pending.forEach(update=>update());
  assert.equal(values[7].day_night_enabled,true);
  assert.equal(values[7].mode,draft.mode);
  for(const variant of ['dark','light']){
   assert.deepEqual(values[7][variant+'_colors'],draft[variant+'_colors'],'all existing colors and missing slots are preserved');
  }
  view=tree(ThemeMenu,props,values);
  toggle=elements(view).find(el=>el.props['aria-label']==='시간 전환을 켰을 때만 사용');
  assert.equal(toggle.props.checked,true);
  assert.equal(elements(view).filter(el=>el.type?.name==='ThemePaletteEditor').length,draft.mode==='dual'?2:1);
  elements(view).find(el=>el.type==='button'&&el.props.children==='테마 저장').props.onClick();await flush();
  const saved=writes.findLast(w=>w.table==='themes').patch;
  assert.equal(saved.day_night_enabled,true);
  assert.deepEqual({dark_colors:saved.dark_colors,light_colors:saved.light_colors},theme.paletteDraftColors(draft));
  toggle.props.onChange({target:{checked:false},currentTarget:{checked:false}});
  assert.equal(values[7].day_night_enabled,false);
  assert.equal(values[7].mode,draft.mode,'turning the condition off also preserves the palette mode');
 }
}
console.log('Work time-switch checkbox: new/single/dual, private/shared, delayed events, palette preservation, save and OFF OK');

for(const [preference,override,enabled,flagged,period,expected] of [
 ['light',null,true,true,'night','dark'],['light',null,true,true,'day','light'],
 ['light',null,false,true,'night','light'],['dark',null,true,true,'night','dark'],
 ['light','custom',true,true,'night','light'],['light',null,true,false,'night','dark']]){
 globalThis.__capturedEffects=[];
 globalThis.__profileResponse={prefer_work_theme:false,preferred_theme_mode:'custom',preferred_theme_id:single.id,preferred_theme_variant:preference};
 globalThis.__themeById={[single.id]:single,[dayTheme.id]:{...dayTheme,day_night_enabled:flagged}};
 globalThis.__themeResponse={...dayTheme,day_night_enabled:flagged};
 globalThis.__themeLocation={pathname:'/chat/30000000-0000-0000-0000-000000000001'};
 globalThis.__sessionResponse={...dayRoom,theme_override:override,theme_day_night_enabled:enabled,theme_period:period,theme_variant:preference};
 tree(ThemeManager,{},[]);const cleanup=globalThis.__capturedEffects[0]();await flush();
 assert.equal(root.dataset.themeVariant,expected);assert.equal(root.dataset.themePreferredVariant,preference);
 const blocked=override==null&&flagged&&!(enabled&&preference==='light');
 assert.equal(properties.get('--page-bg'),blocked?single.dark_colors.main:dayTheme[expected+'_colors'].main);
 cleanup();
}
delete globalThis.__capturedEffects;delete globalThis.__themeResponse;delete globalThis.__themeById;
console.log('Actual night scene application: ON/OFF, dark preference, fixed mode and per-theme eligibility preserve global preference OK');

// An unavailable time-only scene falls back to the exact account custom theme,
// including when inherited as the work default. Fixed manual choices still win.
for(const inherited of [false,true]){
 globalThis.__capturedEffects=[];
 globalThis.__profileResponse={prefer_work_theme:true,preferred_theme_mode:'custom',preferred_theme_id:single.id,preferred_theme_variant:'light'};
 globalThis.__themeById={[single.id]:single,[dayTheme.id]:dayTheme};
 globalThis.__workResponse={default_theme_id:dayTheme.id,default_theme_variant:'light'};
 globalThis.__sessionResponse={...dayRoom,theme_id:inherited?null:dayTheme.id,theme_variant:inherited?null:'light',theme_day_night_enabled:false};
 tree(ThemeManager,{},[]);const cleanup=globalThis.__capturedEffects[0]();await flush();
 assert.equal(properties.get('--page-bg'),single.dark_colors.main);
 assert.equal(root.dataset.themeMode,'single');
 assert.equal(root.dataset.themePreferredVariant,'light');
 cleanup();
}
delete globalThis.__capturedEffects;delete globalThis.__themeById;delete globalThis.__workResponse;
console.log('Time-only scene OFF: current/inherited scenes fall back to the account custom palette without changing stored colors OK');

// The common switch keeps controlled boolean values and blocks disabled writes.
for(const checked of [false,true]){
 let next;
 const toggle=Toggle({'aria-label':'설정 토글',checked,onChange:value=>next=value});
 assert.equal(toggle.props.role,'switch');assert.equal(toggle.props['aria-checked'],checked);
 toggle.props.onClick();assert.equal(next,!checked);
 const disabled=Toggle({'aria-label':'설정 토글',checked,disabled:true,onChange:()=>assert.fail('disabled switch wrote a setting')});
 disabled.props.onClick();
}

baseImports['./OutputTokenSelector']=componentUri('OutputTokenSelector');
const OutputSettingsEditor=(await import(componentUri('OutputSettingsEditor'))).default;
const output={outputTokens:5000,reasoning:{send:true,effort:'medium'},temperature:1,temperatureSend:true,frequencyPenalty:.2,frequencyPenaltySend:false};
let updatedOutput;
const outputView=tree(OutputSettingsEditor,{value:output,onChange:value=>updatedOutput=value,tokenLabel:'출력 토큰'},[]);
for(const row of elements(outputView).filter(el=>typeof el.props.onChecked==='function')){
 const parameter=row.type(row.props);
 const toggle=elements(parameter).find(el=>el.type===Toggle);
 assert.equal(toggle.props['aria-label'],`${row.props.title} 전송`);
 Toggle(toggle.props).props.onClick();
 const expected=row.props.title==='추론'?{...output,reasoning:{...output.reasoning,send:false}}
  :row.props.title==='Temperature'?{...output,temperatureSend:false}:{...output,frequencyPenaltySend:true};
 assert.deepEqual(updatedOutput,expected,'send toggle preserves parameter values and every other output setting');
}

baseImports['@/lib/llm/promptCache']=uri(compile('src/lib/llm/promptCache.ts'));
const PromptCacheSettings=(await import(componentUri('PromptCacheSettings'))).default;
for(const [enabled,autoLatest,label,expectedEnabled,expectedLatest] of [
 [false,false,'이 채팅방에서 명시적 캐시 사용',true,false],
 [true,false,'명시적 캐시를 매 턴 최신으로 갱신',true,true],
 [true,true,'이 채팅방에서 명시적 캐시 사용',false,true],
]){
 let updated;
 const room={...dayRoom,prompt_cache_enabled:enabled,prompt_cache_auto_latest:autoLatest,prompt_cache_message_id:'boundary'};
 const view=tree(PromptCacheSettings,{session:room,turnCount:2,busy:false,onUpdate:patch=>updated=patch},[[{id:'boundary',turn:1}],false,'',0,'1',false,'']);
 const toggle=elements(view).find(el=>el.props['aria-label']===label);
 Toggle(toggle.props).props.onClick();await flush();
 assert.deepEqual(updated,{prompt_cache_enabled:expectedEnabled,prompt_cache_message_id:'boundary',prompt_cache_auto_latest:expectedLatest});
}
const blockedCache=tree(PromptCacheSettings,{session:dayRoom,turnCount:2,busy:true,onUpdate:()=>assert.fail('busy cache changed')},[[],false,'',0,'0',false,'']);
for(const toggle of elements(blockedCache).filter(el=>el.type===Toggle)){
 assert.equal(toggle.props.disabled,true);Toggle(toggle.props).props.onClick();
}
console.log('Common switches: accessible ON/OFF, disabled state, output parameter preservation and both cache save payloads OK');
