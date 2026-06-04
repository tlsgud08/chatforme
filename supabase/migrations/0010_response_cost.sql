-- 응답별 실제 크레딧 비용 저장 (OpenRouter usage.cost)
alter table public.messages add column if not exists cost numeric not null default 0;
alter table public.sessions add column if not exists total_cost numeric not null default 0;
