-- GOB-13 · Roteamento adaptativo: o registro de uso de IA passa a guardar a camada, a estratégia e o motivo de cada
-- chamada (inclusive tentativas de contingência), para comparar estratégias nos mesmos casos.
-- Colunas nulas = chamada anterior ao roteamento ou adaptador sem roteamento. Nada aqui altera política, alçada ou permissão.
alter table public.ai_usage
  add column tier          text check (tier is null or tier in ('economy','reasoning','unico')),
  add column strategy      text check (strategy is null or strategy in ('adaptive','reasoning_only','economy_only','single')),
  add column route_reason  text,
  add column switched_from text check (switched_from is null or switched_from in ('economy','reasoning','unico'));

create index on public.ai_usage (scenario_run_id, strategy, tier);
