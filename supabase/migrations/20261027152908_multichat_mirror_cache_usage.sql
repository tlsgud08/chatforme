-- A PC input, a streaming placeholder, or a provider without cache usage has
-- nullable counters. The ordinary transcript can require NOT NULL counters.
-- Normalize only at this boundary; retain all reported usage and access rules.
create or replace function public.multichat_mirror_message() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 insert into public.messages(id,session_id,role,content,turn_index,reroll_index,is_active_variant,generation_status,input_tokens,output_tokens,cost,cache_read_tokens,cache_write_tokens,created_at,usage_accounted)
 values(new.id,new.room_id,new.role,new.content,new.round_number,new.reroll_index+1,new.is_active_variant,new.generation_status,new.input_tokens,new.output_tokens,new.cost,coalesce(new.cache_read_tokens,0),coalesce(new.cache_write_tokens,0),new.created_at,new.generation_status='complete')
 on conflict(id) do update set content=excluded.content,is_active_variant=excluded.is_active_variant,generation_status=excluded.generation_status,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost=excluded.cost,cache_read_tokens=excluded.cache_read_tokens,cache_write_tokens=excluded.cache_write_tokens,usage_accounted=excluded.usage_accounted;
 return new;
end $$;
