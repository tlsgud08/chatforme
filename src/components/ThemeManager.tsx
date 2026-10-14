import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { guestGetSession } from '@/lib/guest';
import { applyCustomTheme, applyTheme, loadTheme, paletteFor, type SavedTheme, type ThemeVariant } from '@/lib/theme';

type Preference = { prefer_work_theme: boolean; preferred_theme_mode: 'dark' | 'light' | 'custom' | null; preferred_theme_id: string | null; preferred_theme_variant: ThemeVariant | null };
type WorkDefault = { default_theme_id: string | null; default_theme_variant: ThemeVariant | null };
type SessionTheme = { work_id: string; theme_override: 'builtin' | 'custom' | null; theme_id: string | null; theme_variant: ThemeVariant | null };

/** Single owner of document-level theme application. Refetches on route changes,
 * explicit preference updates and browser focus (cross-device sync). */
export default function ThemeManager() {
  const { user, isGuest } = useAuth();
  const location = useLocation();
  useEffect(() => {
    let current = true;
    let generation = 0;
    async function refresh() {
      const run = ++generation;
      if (!user || isGuest) {
        const base=loadTheme()==='dark'?'dark':'light';
        const guestMatch = /^\/chat\/([0-9a-f-]+)$/i.exec(location.pathname);
        const guestSession=guestMatch?guestGetSession(guestMatch[1]):null;
        if(guestSession) {
          const {data:work}=await supabase.from('works').select('default_theme_id,default_theme_variant').eq('id',guestSession.work_id).maybeSingle();
          if(!current||generation!==run)return;
          if(work?.default_theme_id){
            const {data:theme}=await supabase.from('themes').select('*').eq('id',work.default_theme_id).maybeSingle();
            if(!current||generation!==run)return;
            const chosen=theme?paletteFor(theme as SavedTheme,work.default_theme_variant??base):null;
            if(chosen){applyCustomTheme(chosen.palette,chosen.variant);return;}
          }
        }
        applyTheme(base); return;
      }
      const { data: profile } = await supabase.from('profiles')
        .select('prefer_work_theme,preferred_theme_mode,preferred_theme_id,preferred_theme_variant')
        .eq('id', user.id).maybeSingle();
      if (!current || generation!==run) return;
      const pref = profile as Preference | null;
      const userMode = pref?.preferred_theme_mode;
      const legacyMode = loadTheme()==='dark'?'dark':'light';
      const baseVariant: ThemeVariant = (pref?.preferred_theme_variant === 'dark' || pref?.preferred_theme_variant === 'light')
        ? pref.preferred_theme_variant : legacyMode;
      let themeId: string | null = userMode==='custom' ? pref?.preferred_theme_id??null : null;
      let variant: ThemeVariant = userMode==='light'||userMode==='dark' ? userMode : baseVariant;
      const chatMatch = /^\/chat\/([0-9a-f-]+)$/i.exec(location.pathname);
      if (chatMatch) {
        const { data } = await supabase.from('sessions').select('work_id,theme_override,theme_id,theme_variant').eq('id',chatMatch[1]).maybeSingle();
        if (!current || run!==generation) return;
        const session = data as SessionTheme | null;
        if (session?.theme_override==='builtin') {
          themeId=null;
          variant=session.theme_variant??variant;
        } else if (session?.theme_override==='custom') {
          themeId=session.theme_id;
          variant=session.theme_variant??variant;
        } else if (session?.work_id && pref?.prefer_work_theme !== false) {
          const { data: work } = await supabase.from('works').select('default_theme_id,default_theme_variant').eq('id',session.work_id).maybeSingle();
          if (!current || run!==generation) return;
          const selection=work as WorkDefault|null;
          if (selection?.default_theme_id) {
            themeId=selection.default_theme_id;
            variant=selection.default_theme_variant??variant;
          }
        }
      }
      if (themeId) {
        const { data: theme } = await supabase.from('themes').select('*').eq('id',themeId).maybeSingle();
        if (!current || run!==generation) return;
        const selected=theme ? paletteFor(theme as SavedTheme,variant):null;
        if (selected) { applyCustomTheme(selected.palette,selected.variant); return; }
      }
      applyTheme(variant);
    }
    const trigger=()=>{void refresh();};
    void refresh();
    window.addEventListener('inuchat:theme-changed',trigger);
    window.addEventListener('focus',trigger);
    return ()=>{current=false;generation++;window.removeEventListener('inuchat:theme-changed',trigger);window.removeEventListener('focus',trigger);};
  },[user?.id,isGuest,location.pathname]);
  return null;
}
