import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { guestGetSession } from '@/lib/guest';
import { applyCustomTheme, applyTheme, loadTheme, paletteFor, resolveThemeSelection, type SavedTheme, type ThemeVariant } from '@/lib/theme';

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
      const legacyMode = loadTheme()==='dark'?'dark':'light';
      let session: SessionTheme | null = null;
      let workDefault: WorkDefault | null = null;
      const chatMatch = /^\/chat\/([0-9a-f-]+)$/i.exec(location.pathname);
      if (chatMatch) {
        const { data } = await supabase.from('sessions').select('work_id,theme_override,theme_id,theme_variant').eq('id',chatMatch[1]).maybeSingle();
        if (!current || run!==generation) return;
        session = data as SessionTheme | null;
        if (!session?.theme_override && session?.work_id && pref?.prefer_work_theme !== false) {
          const { data: work } = await supabase.from('works').select('default_theme_id,default_theme_variant').eq('id',session.work_id).maybeSingle();
          if (!current || run!==generation) return;
          workDefault = work as WorkDefault | null;
        }
      }
      const {themeId,variant} = resolveThemeSelection(pref,workDefault,session,legacyMode);
      if (themeId) {
        const { data: theme } = await supabase.from('themes').select('*').eq('id',themeId).maybeSingle();
        if (!current || run!==generation) return;
        const selected=theme ? paletteFor(theme as SavedTheme,variant):null;
        if (selected) { applyCustomTheme(selected.palette,selected.variant); return; }
      }
      applyTheme(variant);
    }
    const trigger=()=>{void refresh();};
    const visibility=()=>{if(document.visibilityState==='visible')void refresh();};
    void refresh();
    window.addEventListener('inuchat:theme-changed',trigger);
    window.addEventListener('focus',trigger);
    window.addEventListener('pageshow',trigger);
    document.addEventListener('visibilitychange',visibility);
    return ()=>{current=false;generation++;window.removeEventListener('inuchat:theme-changed',trigger);window.removeEventListener('focus',trigger);window.removeEventListener('pageshow',trigger);document.removeEventListener('visibilitychange',visibility);};
  },[user?.id,isGuest,location.pathname]);
  return null;
}
