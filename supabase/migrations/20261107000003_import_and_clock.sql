-- GOB-03 · Tabelas de origem complementares, relógio do cenário e reset isolado.
-- Dados de origem: sem scenario_run_id. Registros da GoBIA: sempre com scenario_run_id.

-- Marca do grupo usada pelo brinde de campanha (GBT-9001, marca "GoBeauté" no catálogo).
insert into public.brands (id, name, business_unit_id) values ('gobeaute', 'GoBeauté', 'gobeaute')
on conflict (id) do nothing;

-- Um cenário por nome (o script de importação cria/reutiliza o cenário padrão).
create unique index scenario_runs_name_uq on public.scenario_runs (name);

-- Lotes GoBeauté. Lote sozinho não é único: a identidade é lote + SKU.
create table public.product_lots (
  lot                text not null,
  sku                text not null references public.products (sku),
  brand_id           text references public.brands (id),
  manufacturer       text,
  manufactured_on    date,
  expires_on         date,
  quantity           integer,
  quality_released_on date,
  quality_report     text,
  quality_status     text,
  primary key (lot, sku)
);
create index on public.product_lots (sku);

-- Eventos de rastreio dos portais das transportadoras (evidência datada).
create table public.tracking_events (
  id              bigint generated always as identity primary key,
  order_id        text not null references public.orders (order_id) on delete cascade,
  portal          text not null,
  event_at        timestamptz not null,
  status          text not null,
  location        text,
  expected_on     date,
  tracking_code   text,
  unique (order_id, portal, event_at, status)
);
create index on public.tracking_events (order_id, event_at);

-- Políticas vigentes da base (texto + busca textual). Escopo é grupo: a base não traz regras por marca.
create table public.policies (
  section    text not null,
  rule       text not null,
  value      text,
  version    text not null,
  scope      text not null default 'group',
  valid_from date,
  search     tsvector generated always as (
    to_tsvector('portuguese', coalesce(section, '') || ' ' || coalesce(rule, '') || ' ' || coalesce(value, ''))
  ) stored,
  primary key (section, rule)
);
create index policies_search_idx on public.policies using gin (search);

-- Catálogo de ferramentas: especificação, não integração executável.
create table public.tool_catalog (
  tool          text primary key,
  kind          text,
  allowed_roles text[] not null default '{}',
  description   text,
  parameters    text,
  limits        jsonb not null default '{}'::jsonb,
  cost_cents    integer
);

alter table public.product_lots    enable row level security;
alter table public.tracking_events enable row level security;
alter table public.policies        enable row level security;
alter table public.tool_catalog    enable row level security;

grant select on public.product_lots, public.tracking_events, public.policies, public.tool_catalog to authenticated;

create policy lots_scope on public.product_lots for select to authenticated
  using (exists (select 1 from public.products p where p.sku = product_lots.sku));
create policy tracking_scope on public.tracking_events for select to authenticated
  using (exists (select 1 from public.orders o where o.order_id = tracking_events.order_id));
create policy policies_read on public.policies for select to authenticated
  using (private.current_staff_id() is not null);
create policy tool_catalog_read on public.tool_catalog for select to authenticated
  using (private.current_staff_id() is not null);

-- Visões temporais: só o que já existe no relógio do cenário (security invoker: a RLS do chamador continua valendo).
create function public.orders_as_of(p_run uuid) returns setof public.orders
language sql stable security invoker set search_path = '' as $$
  select o.* from public.orders o
  where o.ordered_at <= (select r.clock_now from public.scenario_runs r where r.id = p_run)
$$;

create function public.order_items_as_of(p_run uuid) returns setof public.order_items
language sql stable security invoker set search_path = '' as $$
  select i.* from public.order_items i
  join public.orders_as_of(p_run) o on o.order_id = i.order_id
$$;

create function public.tracking_events_as_of(p_run uuid) returns setof public.tracking_events
language sql stable security invoker set search_path = '' as $$
  select t.* from public.tracking_events t
  join public.orders_as_of(p_run) o on o.order_id = t.order_id
  where t.event_at <= (select r.clock_now from public.scenario_runs r where r.id = p_run)
$$;

create function public.conversations_as_of(p_run uuid) returns setof public.conversations
language sql stable security invoker set search_path = '' as $$
  select c.* from public.conversations c
  where c.opened_at <= (select r.clock_now from public.scenario_runs r where r.id = p_run)
    and (c.scenario_run_id is null or c.scenario_run_id = p_run)
$$;

-- Avanço do relógio (1 tique = 1 hora; o cenário termina em 08/11/2026 23:59). Apenas servidor.
create function public.advance_scenario_clock(p_run uuid, p_hours integer) returns timestamptz
language plpgsql security invoker set search_path = '' as $$
declare
  v_end constant timestamptz := '2026-11-08 23:59:00-03';
  v_now timestamptz;
begin
  if p_hours is null or p_hours < 0 then
    raise exception 'p_hours deve ser >= 0';
  end if;
  update public.scenario_runs
     set clock_now = least(clock_now + make_interval(hours => p_hours), v_end)
   where id = p_run
   returning clock_now into v_now;
  if v_now is null then
    raise exception 'cenário % não encontrado', p_run;
  end if;
  return v_now;
end $$;

-- Reset: remove apenas os registros operacionais do cenário e volta o relógio ao início.
-- Dados de origem (scenario_run_id nulo) e outros cenários não são tocados.
-- Tabelas operacionais futuras (propostas, execuções, auditoria) devem ser incluídas aqui.
create function public.reset_scenario_run(p_run uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.scenario_runs where id = p_run) then
    raise exception 'cenário % não encontrado', p_run;
  end if;
  delete from public.cases where scenario_run_id = p_run;
  delete from public.conversations where scenario_run_id = p_run;
  update public.scenario_runs set clock_now = clock_start where id = p_run;
end $$;

revoke execute on function public.advance_scenario_clock(uuid, integer), public.reset_scenario_run(uuid)
  from public, anon, authenticated;
grant execute on function public.advance_scenario_clock(uuid, integer), public.reset_scenario_run(uuid)
  to service_role;

-- Escrita no relógio e visões temporais ficam para o servidor: o navegador só lê via RLS.
revoke execute on function public.orders_as_of(uuid), public.order_items_as_of(uuid),
  public.tracking_events_as_of(uuid), public.conversations_as_of(uuid) from public, anon;
grant execute on function public.orders_as_of(uuid), public.order_items_as_of(uuid),
  public.tracking_events_as_of(uuid), public.conversations_as_of(uuid) to authenticated, service_role;
