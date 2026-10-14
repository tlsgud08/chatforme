import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { showConfirmDialog } from '@/lib/dialog';
import ThemePaletteEditor from './ThemePaletteEditor';
import './ThemeMenu.css';
import { DEFAULT_DARK, DEFAULT_LIGHT, paletteFor, validPalette, type SavedTheme, type ThemePalette, type ThemeVariant } from '@/lib/theme';

type Tab = 'all'|'work'|'mine'|'hub'|'favorites';
type Props = {
  userId: string;
  workId?: string;
  allowWorkCreate?: boolean;
  embedded?: boolean;
  scope?: 'work' | 'global';
  selectedId?: string|null;
  onSelect?: (theme: SavedTheme) => void;
  onClose?: () => void;
};
const labels: Record<Tab,string>={all:'전체',work:'작품',mine:'내 테마',hub:'테마 허브',favorites:'즐겨찾기'};
type Draft = {name:string;description:string;ai_prompt:string;dark_colors:ThemePalette|null;light_colors:ThemePalette|null};
function defaultDraft():Draft {return {name:'',description:'',ai_prompt:'',dark_colors:{...DEFAULT_DARK},light_colors:{...DEFAULT_LIGHT}};}
function currentVariant(): ThemeVariant {
  if (typeof document === 'undefined') return 'light';
  const { theme, themeVariant } = document.documentElement.dataset;
  return (theme === 'custom' ? themeVariant : theme) === 'dark' ? 'dark' : 'light';
}
function useCurrentVariant() {
  const [variant, setVariant] = useState(currentVariant);
  useEffect(() => {
    const update = () => setVariant(currentVariant());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-variant'] });
    update();
    return () => observer.disconnect();
  }, []);
  return variant;
}
export default function ThemeMenu({userId,workId,allowWorkCreate=false,embedded=false,scope,selectedId,onSelect,onClose}:Props){
  const variant = useCurrentVariant();
  const [themes,setThemes]=useState<SavedTheme[]>([]);
  const [favorites,setFavorites]=useState<Set<string>>(new Set());
  const [workNames,setWorkNames]=useState<Record<string,string>>({});
  const [tab,setTab]=useState<Tab>(scope==='global'?'all':workId?'work':'all');
  const [search,setSearch]=useState('');
  const [editing,setEditing]=useState<SavedTheme|'new'|null>(null);
  const [draft,setDraft]=useState<Draft>(defaultDraft);
  const [busy,setBusy]=useState(false);
  const [opened,setOpened]=useState<string|null>(null);
  const load=useCallback(async()=>{
    // Supabase limits single SELECT responses (usually 1,000 rows).
    // Page both catalogs so "전체" and "즐겨찾기" do not silently truncate.
    const fetchThemes = async () => {
      const items: SavedTheme[] = [];
      for(let start=0;;start+=500){
        const {data,error}=await supabase.from('themes').select('*')
          .order('updated_at',{ascending:false}).order('id',{ascending:false})
          .range(start,start+499);
        if(error)throw error;
        items.push(...((data??[]) as SavedTheme[]));
        if((data??[]).length<500)return items;
      }
    };
    const fetchFavorites = async () => {
      const ids:string[]=[];
      for(let start=0;;start+=500){
        const {data,error}=await supabase.from('theme_favorites').select('theme_id')
          .eq('user_id',userId).order('theme_id').range(start,start+499);
        if(error)throw error;
        ids.push(...(data??[]).map(row=>row.theme_id));
        if((data??[]).length<500)return ids;
      }
    };
    let data: SavedTheme[], stars:string[];
    try{[data,stars]=await Promise.all([fetchThemes(),fetchFavorites()]);}
    catch(error){showToast('테마 목록을 불러오지 못했습니다: '+(error instanceof Error?error.message:String(error)));return;}
    setThemes(data);
    const workIds=[...new Set(data.map((t:SavedTheme)=>t.work_id).filter((id):id is string=>!!id))];
    if(workIds.length){const {data:works}=await supabase.from('works').select('id,title').in('id',workIds);setWorkNames(Object.fromEntries((works??[]).map(w=>[w.id,w.title])));}
    setFavorites(new Set(stars));
  },[userId]);
  useEffect(()=>{void load();},[load]);
  const visible=useMemo(()=>themes.filter(t=>{
    if(scope==='work'&&t.work_id!==workId)return false;
    if(scope==='global'&&t.work_id)return false;
    const active=tab==='all'?(t.work_id===null||!workId||t.work_id===workId)
      :tab==='work'?!!t.work_id&&(!workId||t.work_id===workId)
      :tab==='mine'?t.work_id===null&&t.owner_id===userId
      :tab==='hub'?t.work_id===null&&t.is_published
      :favorites.has(t.id);
    return active&&(!search.trim()||[t.name,t.description].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  }),[themes,tab,workId,userId,favorites,search,scope]);
  function edit(theme?:SavedTheme){setEditing(theme??'new');setDraft(theme?{name:theme.name,description:theme.description,ai_prompt:theme.ai_prompt??'',dark_colors:theme.dark_colors?{...theme.dark_colors}:null,light_colors:theme.light_colors?{...theme.light_colors}:null}:defaultDraft());}
  async function save(){
    if(!draft.name.trim()||(!draft.dark_colors&&!draft.light_colors)||[draft.dark_colors,draft.light_colors].some(p=>p!==null&&!validPalette(p))){showToast('이름, 하나 이상의 버전, 올바른 HEX 색상 4개를 지정하세요.');return;}
    const name=draft.name.trim();
    if((scope==='work'||allowWorkCreate||(editing!=='new'&&editing?.work_id))&&(name==='keep'||/[{}\n\r]/.test(name))){showToast('작품 테마 이름에는 keep, 중괄호, 줄바꿈을 사용할 수 없습니다.');return;}
    const targetWork=editing==='new'?(scope==='work'||allowWorkCreate?workId:null):editing?.work_id;
    if(targetWork&&themes.some(t=>t.work_id===targetWork&&t.name.trim()===name&&t.id!==(editing==='new'?null:editing?.id))){showToast('사용 가능한 작품 테마에 같은 이름이 있습니다. 다른 이름을 사용해 주세요.');return;}
    setBusy(true);
    const payload={name:draft.name.trim(),description:draft.description.trim(),ai_prompt:draft.ai_prompt.trim(),dark_colors:draft.dark_colors,light_colors:draft.light_colors};
    const result=editing==='new'
      ?await supabase.from('themes').insert({...payload,owner_id:userId,work_id:workId&&(scope==='work'||allowWorkCreate)?workId:null,work_shared:allowWorkCreate,is_published:false}).select('*').single()
      :await supabase.from('themes').update(payload).eq('id',(editing as SavedTheme).id).select('*').single();
    setBusy(false);
    if(result.error){showToast('테마 저장 실패: '+result.error.message);return;}
    setEditing(null);showToast('테마를 저장했습니다.');await load();
    // Invalidate any currently visible use of the edited palette.
    window.dispatchEvent(new Event('inuchat:theme-changed'));
  }
  async function toggleFavorite(t:SavedTheme){
    if(t.work_id)return;
    const starred=favorites.has(t.id);
    const {error}=starred
      ?await supabase.from('theme_favorites').delete().eq('user_id',userId).eq('theme_id',t.id)
      :await supabase.from('theme_favorites').insert({user_id:userId,theme_id:t.id});
    if(error){showToast(error.message);return;}await load();
  }
  async function togglePublish(t:SavedTheme){
    if(t.work_id)return;
    const {error}=await supabase.from('themes').update({is_published:!t.is_published}).eq('id',t.id);
    if(error)showToast(error.message);else {await load();window.dispatchEvent(new Event('inuchat:theme-changed'));}
  }
  async function copy(t:SavedTheme){
    if(t.work_id){showToast('작품 전용 테마는 다른 작품으로 복사할 수 없습니다.');return;}
    const {error}=await supabase.from('themes').insert({owner_id:userId,work_id:null,name:t.name.slice(0,74)+' (복사본)',description:t.description,dark_colors:t.dark_colors,light_colors:t.light_colors,is_published:false,copied_from_id:t.id});
    if(error)showToast(error.message);else{setTab('mine');await load();}
  }
  async function remove(t:SavedTheme){
    if(!await showConfirmDialog('테마를 삭제할까요?','이 테마를 사용하는 채팅방은 기본 테마로 돌아갑니다.','삭제'))return;
    const {error}=await supabase.from('themes').delete().eq('id',t.id);
    if(error)showToast(error.message);else{await load();window.dispatchEvent(new Event('inuchat:theme-changed'));}
  }
  if(editing)return <div className="flex flex-col gap-3 p-3">
    <div className="flex items-center justify-between"><h3 className="font-semibold text-white">{editing==='new'?'테마 제작':'테마 편집'}</h3><button onClick={()=>setEditing(null)} className="text-sm text-slate-400">취소</button></div>
    <label className="text-xs text-slate-400">테마 이름<input maxLength={80} value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))} className="mt-1 w-full rounded-lg bg-surface p-3 text-sm text-white"/></label>
    <label className="text-xs text-slate-400">설명<textarea maxLength={500} rows={2} value={draft.description} onChange={e=>setDraft(d=>({...d,description:e.target.value}))} className="mt-1 w-full rounded-lg bg-surface p-3 text-sm text-white"/></label>
    {(scope==='work'||allowWorkCreate||!!(editing!=='new'&&editing?.work_id))&&<label className="text-xs text-slate-400">AI 적용 조건<textarea maxLength={4000} rows={4} value={draft.ai_prompt} onChange={e=>setDraft(d=>({...d,ai_prompt:e.target.value}))} placeholder="이 테마를 언제 사용해야 하는지 설명하세요." className="mt-1 w-full rounded-lg bg-surface p-3 text-sm text-white"/></label>}
    {scope==='work'&&!allowWorkCreate&&<p className="text-xs text-slate-400">본인만 이 작품에서 사용할 수 있으며, 자동 테마 변경의 선택지에 포함됩니다.</p>}
    {(['dark','light']as const).map(v=><ThemePaletteEditor key={v} variant={v} palette={draft[v==='dark'?'dark_colors':'light_colors']} onChange={p=>setDraft(d=>({...d,[v+'_colors']:p}))} onDisable={()=>setDraft(d=>({...d,[v+'_colors']:null}))}/>)}
    <p className="text-xs text-slate-400">각 버전의 4가지 색상은 독립적으로 설정됩니다. 자동 변환하지 않습니다.</p>
    <button disabled={busy} onClick={()=>void save()} className="rounded-lg bg-brand px-4 py-3 text-sm font-bold text-white disabled:opacity-50">테마 저장</button>
  </div>;
  return <section className="flex flex-col">
    <header className="flex items-center justify-between px-3 pt-3">
      <strong className="text-white">테마 {workId?'선택 및 관리':''}</strong>
      {onClose&&<button className="text-slate-400" onClick={onClose} aria-label="닫기">✕</button>}
    </header>
    <nav aria-label="테마 목록" className="flex gap-2 overflow-x-auto px-3 py-3">
      {(['all','work','mine','hub','favorites']as const).filter(t=>scope==='work'?t==='work':scope==='global'?t!=='work':true).map(t=><button key={t} aria-pressed={tab===t} onClick={()=>setTab(t)} className={`shrink-0 rounded-full px-3 py-2 text-xs ${tab===t?'bg-brand text-white':'bg-surface2 text-slate-400'}`}>{labels[t]}</button>)}
    </nav>
    <div className="px-3 pb-3"><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="테마 이름·설명 검색" className="w-full rounded-lg bg-surface px-3 py-2 text-sm text-white"/></div>
    {visible.length===0&&<p className="p-5 text-center text-sm text-slate-500">테마가 없습니다.</p>}
    <div className={embedded?'':'max-h-[45vh] overflow-y-auto'}>
      {visible.map(t=>{
        const editable=t.work_id?(t.work_shared!==false?allowWorkCreate&&t.work_id===workId:t.owner_id===userId):t.owner_id===userId;
        const selectable=!t.work_id||t.work_id===workId;
        const preview = paletteFor(t, variant);
        const palette = preview?.palette ?? (variant === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT);
        return <article key={t.id} className="theme-card" data-preview-variant={preview?.variant ?? variant}
          style={{backgroundColor:palette.main,color:palette.mainText}}>
          <div className="theme-card-header" style={{backgroundColor:palette.accent,color:palette.accentText}}>
            <button onClick={()=>selectable&&onSelect?onSelect(t):setOpened(opened===t.id?null:t.id)} disabled={!!onSelect&&!selectable} className="min-w-0 flex-1 text-left disabled:opacity-40" style={{color:'inherit'}}>
              <span className="block break-words text-sm font-semibold">{selectedId===t.id?'✓ ':''}{t.name}</span>
            </button>
            <div className="flex shrink-0 gap-1">
              <button onClick={()=>void toggleFavorite(t)} disabled={!!t.work_id} aria-label="즐겨찾기" className="p-1 disabled:opacity-30" style={{color:'inherit'}}>{favorites.has(t.id)?'★':'☆'}</button>
              <button onClick={()=>setOpened(opened===t.id?null:t.id)} aria-label="테마 메뉴" className="p-1" style={{color:'inherit'}}>⋯</button>
            </div>
          </div>
          <div className="theme-card-body">
            <button type="button" onClick={()=>selectable&&onSelect?onSelect(t):setOpened(opened===t.id?null:t.id)}
              disabled={!!onSelect&&!selectable} className="block w-full text-left disabled:opacity-40" style={{color:'inherit'}}>
            <span className="block truncate text-xs">{t.description||'설명 없음'}</span>
            <span className="text-[11px]">{t.work_id?(t.work_shared===false?'내 작품 전용 · ':'작품 공용 · ')+(workNames[t.work_id]??'전용')+' · ':t.is_published?'허브 공개 · ':'개인 · '}{t.dark_colors?'🌙 다크 ':''}{t.light_colors?'☀️ 라이트':''}</span>
            </button>
            <span className="block text-[11px] opacity-80">미리보기 · {(preview?.variant??variant)==='dark'?'다크':'라이트'}</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {([['dark',t.dark_colors],['light',t.light_colors]]as const).filter(([,p])=>!!p).map(([name,p])=>
              <button key={name} type="button" disabled={!editable} onClick={()=>edit(t)}
                aria-label={`${t.name} ${name==='dark'?'다크':'라이트'} 버전 수정`}
                title={editable?'눌러서 테마 수정':'수정 권한이 없는 테마입니다'}
                className="flex min-h-11 items-center gap-1 rounded-lg px-2 py-1 disabled:cursor-default"
                style={{backgroundColor:p!.main,color:p!.mainText}}>
                <span aria-hidden="true" className="text-[10px]">{name==='dark'?'🌙':'☀️'}</span>
                {[p!.accent,p!.accentText,p!.main,p!.mainText].map((color,i)=><span key={i} aria-hidden="true" className="h-4 w-4 rounded-sm" style={{backgroundColor:color,border:'1px solid currentColor'}}/>)}
              </button>)}
          </div>
          {opened===t.id&&<div className="mt-3 flex flex-wrap gap-2">
            {editable&&<button onClick={()=>edit(t)} className="theme-card-action rounded-lg px-3 py-2 text-xs">수정</button>}
            {editable&&!t.work_id&&<button onClick={()=>void togglePublish(t)} className="theme-card-action rounded-lg px-3 py-2 text-xs">{t.is_published?'비공개':'허브 공개'}</button>}
            {!t.work_id&&<button onClick={()=>void copy(t)} className="theme-card-action rounded-lg px-3 py-2 text-xs">내 테마로 복사</button>}
            {editable&&<button onClick={()=>void remove(t)} className="theme-card-action rounded-lg px-3 py-2 text-xs">삭제</button>}
          </div>}
          </div>
        </article>;
      })}
    </div>
    <button onClick={()=>edit()} className="m-3 rounded-xl border border-brand/40 py-3 text-sm font-semibold text-brand">＋ {allowWorkCreate?'작품 공용 테마':scope==='work'?'내 작품 전용 테마':'내 테마'} 제작</button>
  </section>;
}
