// DB 테이블에 대응하는 TypeScript 타입 (supabase/migrations/0001_init.sql 와 일치)

export type Provider = 'openrouter' | 'claude' | 'gemini' | 'openai';
export type Role = 'user' | 'assistant';

export interface Profile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  default_output_tokens: number | null;
  default_provider: Provider;
  default_model: string;
  created_at: string;
}

export interface PlatformConfig {
  id: number;
  system_prompt: string;
  updated_at: string;
}

export interface Work {
  id: string;
  creator_id: string;
  title: string;
  description: string;
  thumbnail_url: string | null;
  main_prompt: string;
  is_published: boolean;
  visibility: 'public' | 'unlisted' | 'private';
  created_at: string;
  updated_at: string;
}

export interface StartConfig {
  id: string;
  work_id: string;
  name: string;
  initial_message: string;
  initial_context: string;
  keep_turns: number;
  sort_order: number;
  is_default: boolean;
  created_at: string;
}

export interface KeywordBook {
  id: string;
  work_id: string;
  name: string;
  keywords: string[];
  content: string;
  activation_turns: number;
  sort_order: number;
  created_at: string;
}

export interface Persona {
  id: string;
  user_id: string;
  name: string;
  description: string;
  is_default: boolean;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  work_id: string;
  title: string;
  persona_id: string | null;
  start_config_id: string | null;
  user_note: string;
  output_tokens_override: number | null;
  summary: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: Role;
  content: string;
  turn_index: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  is_hidden: boolean;
  is_summarized: boolean;
  created_at: string;
}

export interface Follow {
  follower_id: string;
  following_id: string;
  created_at: string;
}
