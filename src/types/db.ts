// DB 테이블에 대응하는 TypeScript 타입 (supabase/migrations/0001_init.sql 와 일치)

export type Provider = 'openrouter';
export type Role = 'user' | 'assistant';

export interface Profile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  default_output_tokens: number | null;
  default_provider: Provider;
  default_model: string;
  summary_prompt: string | null;
  summary_model: string | null;
  summary_reasoning: import('@/lib/llm/types').ReasoningSelection | null;
  summary_interval: number;
  summary_level: number;
  summary_allow_omission: boolean;
  summary_parameters_enabled: boolean;
  summary_extra_note: string;
  summary_source_mode: 'incremental' | 'full';
  summary_cost_enabled: boolean;
  summary_cost_currency: 'USD' | 'KRW';
  summary_cost_threshold: number;
  favorite_models: string[];
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
  auto_summary_enabled: boolean;
  summary_interval: number;
  summary_last_turn: number;
  summary_model_override: string | null;
  summary_reasoning_override: import('@/lib/llm/types').ReasoningSelection | null;
  summary_interval_override: number | null;
  summary_level_override: number | null;
  summary_allow_omission_override: boolean | null;
  summary_parameters_enabled_override: boolean | null;
  summary_source_mode_override: 'incremental' | 'full' | null;
  summary_cost_enabled_override: boolean | null;
  summary_cost_currency_override: 'USD' | 'KRW' | null;
  summary_cost_threshold_override: number | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface SummaryVersion {
  id: string;
  session_id: string;
  content: string;
  summarized_through_turn: number;
  is_active: boolean;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  created_at: string;
}

export interface StoryNote {
  id: string;
  session_id: string;
  content: string;
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
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost: number;
  is_hidden: boolean;
  is_summarized: boolean;
  reroll_group_id: string | null;
  reroll_index: number;
  is_active_variant: boolean;
  generation_status: 'streaming' | 'complete' | 'interrupted';
  command_id: string | null;
  command_name: string | null;
  command_prompt: string | null;
  created_at: string;
}

export interface Command {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  prompt: string;
  is_published: boolean;
  copied_from_id: string | null;
  created_at: string;
  updated_at: string;
}
