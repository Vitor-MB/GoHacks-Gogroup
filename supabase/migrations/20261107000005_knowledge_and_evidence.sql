-- GOB-05 · Consultas por identificador e busca textual (Full Text Search em português) sobre políticas e fichas de produto.
-- Sem embeddings e sem chamadas de IA. A autorização é da RLS (cliente da sessão) mais os filtros de marca/unidade/SKU da RPC.

-- ---------------------------------------------------------------------------
-- Configuração de busca: português + remoção de acentos ("devolucao" encontra "devolução").
-- ---------------------------------------------------------------------------
create extension if not exists unaccent with schema extensions;

create text search configuration public.pt_unaccent (copy = pg_catalog.portuguese);
alter text search configuration public.pt_unaccent
  alter mapping for asciiword, asciihword, hword_asciipart, word, hword, hword_part
  with extensions.unaccent, portuguese_stem;

-- ---------------------------------------------------------------------------
-- Evidências de origem que ainda não estavam no banco (chamados, anexos, máquinas de personalização).
-- ---------------------------------------------------------------------------
create table public.carrier_tickets (
  ticket_id        text primary key,
  carrier          text not null,
  order_id         text not null references public.orders (order_id) on delete cascade,
  tracking_code    text,
  conversation_id  text references public.conversations (conversation_id) on delete set null,
  action_id        text,
  opened_by        text,
  opened_at        timestamptz not null,
  reason           text,
  response_due_at  timestamptz,
  status           text,
  responded_at     timestamptz,
  carrier_response text,
  new_expected_on  date,
  closed_at        timestamptz
);
create index on public.carrier_tickets (order_id, opened_at);

create table public.attachments (
  attachment_id      text primary key,
  conversation_id    text references public.conversations (conversation_id) on delete cascade,
  message_id         text,
  order_id           text references public.orders (order_id) on delete cascade,
  customer_id        text references public.customers (customer_id),
  channel            text,
  sent_at            timestamptz not null,
  kind               text,
  perceptual_hash    text,
  exif_captured_at   timestamptz,
  exif_camera        text,
  exif_software      text,
  visual_description text
);
create index on public.attachments (order_id, sent_at);

create table public.print_machines (
  machine_id                   text primary key,
  fulfillment_center           text,
  maker_model                  text,
  technology                   text,
  product_types                text[] not null default '{}',
  capacity_per_hour            integer,
  installed_on                 date,
  last_cartridge_change_on     date,
  last_preventive_maintenance_on date,
  status                       text
);

alter table public.carrier_tickets enable row level security;
alter table public.attachments     enable row level security;
alter table public.print_machines  enable row level security;

grant select on public.carrier_tickets, public.attachments, public.print_machines to authenticated;

-- Herdam o escopo do pedido (a RLS de orders vale na subconsulta).
create policy carrier_tickets_scope on public.carrier_tickets for select to authenticated
  using (exists (select 1 from public.orders o where o.order_id = carrier_tickets.order_id));
create policy attachments_scope on public.attachments for select to authenticated
  using (exists (select 1 from public.orders o where o.order_id = attachments.order_id));
create policy print_machines_read on public.print_machines for select to authenticated
  using (private.current_staff_id() is not null);

-- Visões temporais: só o que já aconteceu no relógio do cenário (security invoker: a RLS do chamador continua valendo).
create function public.carrier_tickets_as_of(p_run uuid) returns setof public.carrier_tickets
language sql stable security invoker set search_path = '' as $$
  select t.* from public.carrier_tickets t
  join public.orders_as_of(p_run) o on o.order_id = t.order_id
  where t.opened_at <= (select r.clock_now from public.scenario_runs r where r.id = p_run)
$$;

create function public.attachments_as_of(p_run uuid) returns setof public.attachments
language sql stable security invoker set search_path = '' as $$
  select a.* from public.attachments a
  join public.orders_as_of(p_run) o on o.order_id = a.order_id
  where a.sent_at <= (select r.clock_now from public.scenario_runs r where r.id = p_run)
$$;

revoke execute on function public.carrier_tickets_as_of(uuid), public.attachments_as_of(uuid) from public, anon;
grant execute on function public.carrier_tickets_as_of(uuid), public.attachments_as_of(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Documentos de conhecimento: um trecho citável por regra/grupo de política e um por ficha de produto.
-- ---------------------------------------------------------------------------
create table public.knowledge_documents (
  id               text primary key,   -- policy:<seção>[/<grupo>] ou product:<sku>
  kind             text not null check (kind in ('policy', 'product')),
  source           text not null,      -- arquivo/tabela de origem
  source_ref       text not null,      -- seção/regra ou SKU
  title            text not null,
  body             text not null,
  version          text not null,
  valid_from       date,
  valid_to         date,
  scope            text not null check (scope in ('group', 'unit', 'brand', 'sku')),
  business_unit_id text references public.business_units (id),
  brand_id         text references public.brands (id),
  sku              text references public.products (sku) on delete cascade,
  category         text,               -- chave exata da política (ex.: atraso_entrega) ou seção
  critical         boolean not null default false,
  search           tsvector generated always as (
    setweight(to_tsvector('public.pt_unaccent', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('public.pt_unaccent', coalesce(category, '')), 'A') ||
    setweight(to_tsvector('public.pt_unaccent', coalesce(body, '')), 'B')
  ) stored,
  check (
    (scope = 'group' and business_unit_id is null and brand_id is null and sku is null) or
    (scope = 'unit'  and business_unit_id is not null and brand_id is null and sku is null) or
    (scope = 'brand' and brand_id is not null and sku is null) or
    (scope = 'sku'   and sku is not null and brand_id is not null and business_unit_id is not null)
  )
);
create index knowledge_documents_search_idx on public.knowledge_documents using gin (search);
create index on public.knowledge_documents (category);
create index on public.knowledge_documents (sku);
create index on public.knowledge_documents (brand_id);

alter table public.knowledge_documents enable row level security;
grant select on public.knowledge_documents to authenticated;

-- Regras do grupo: qualquer funcionário ativo. Fichas de produto: só dentro do escopo de unidade/marca do funcionário.
create policy knowledge_scope on public.knowledge_documents for select to authenticated
  using (
    private.current_staff_id() is not null
    and (scope = 'group' or private.can_access(business_unit_id, brand_id))
  );

-- Reconstrói os documentos a partir de policies e products (idempotente; chamada após a importação).
create function public.rebuild_knowledge() returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  v_version text := (select max(version) from public.policies);
  v_n integer;
begin
  delete from public.knowledge_documents where true;

  -- Políticas: categorias e prazos agrupam pelo prefixo da regra; as demais seções viram um documento.
  insert into public.knowledge_documents
    (id, kind, source, source_ref, title, body, version, valid_from, valid_to, scope, category, critical)
  select
    'policy:' || g.section || coalesce('/' || nullif(g.grp, ''), ''),
    'policy',
    'BD/politicas.csv',
    g.section || coalesce('/' || nullif(g.grp, ''), ''),
    replace(g.section, '_', ' ') || coalesce(' · ' || replace(nullif(g.grp, ''), '_', ' '), ''),
    g.body,
    g.version,
    g.valid_from,
    g.valid_to,
    'group',
    case when g.section = 'categorias' then g.grp else g.section end,
    g.section in ('categorias', 'limites_por_papel', 'reclamacao_suspeita', 'seguranca', 'dados_pessoais')
  from (
    select
      p.section,
      case when p.section in ('categorias', 'prazos_entrega') and position('.' in p.rule) > 0
           then split_part(p.rule, '.', 1) else '' end as grp,
      string_agg(
        case when p.section in ('categorias', 'prazos_entrega') and position('.' in p.rule) > 0
             then substr(p.rule, position('.' in p.rule) + 1) else p.rule end
        || ': ' || coalesce(p.value, ''),
        E'\n' order by p.rule) as body,
      max(p.version) as version,
      case when p.section = 'campanha_vigente'
           then (select (ci.value)::date from public.policies ci where ci.section = 'campanha_vigente' and ci.rule = 'inicio')
           else max(p.valid_from) end as valid_from,
      case when p.section = 'campanha_vigente'
           then (select (cf.value)::date from public.policies cf where cf.section = 'campanha_vigente' and cf.rule = 'fim')
           else null end as valid_to
    from public.policies p
    where p.section not in ('versao', 'dominio')
    group by p.section, 2
  ) g;

  -- Fichas de produto: cada característica fica na ficha do próprio SKU.
  insert into public.knowledge_documents
    (id, kind, source, source_ref, title, body, version, valid_from, scope, business_unit_id, brand_id, sku, category, critical)
  select
    'product:' || pr.sku,
    'product',
    'BD/produtos.csv',
    pr.sku,
    pr.name || ' (' || pr.sku || ')',
    concat_ws(E'\n',
      'Produto: ' || pr.name,
      'Marca: ' || b.name,
      'Categoria: ' || pr.category || coalesce(' / ' || pr.kind, ''),
      'Apresentação: ' || (pr.attributes ->> 'presentation'),
      'Conteúdo: ' || (pr.attributes ->> 'content'),
      'Composição: ' || pr.composition,
      'Modo de uso: ' || pr.usage_instructions,
      'Advertências: ' || pr.warnings,
      'Notas olfativas: ' || (pr.attributes ->> 'olfactory_notes'),
      'Fixação: ' || (pr.attributes ->> 'fixation'),
      'Validade fechado (meses): ' || pr.shelf_life_months,
      'Validade após aberto: ' || (pr.attributes ->> 'shelf_life_after_opening'),
      'Vegano: ' || (pr.attributes ->> 'vegan'),
      'Cruelty free: ' || (pr.attributes ->> 'cruelty_free'),
      'Sem glúten e sem lactose: ' || (pr.attributes ->> 'gluten_lactose_free'),
      'Liberado low poo: ' || (pr.attributes ->> 'low_poo'),
      'Registro Anvisa: ' || pr.anvisa_registry,
      'Personalizável: ' || case when pr.personalizable then 'sim (' || coalesce(pr.personalization_type, 'tipo não informado') || ')' else 'não' end,
      'Prazo de produção (dias úteis): ' || pr.production_days,
      'Modelo compatível: ' || (pr.attributes ->> 'compatible_model'),
      'Situação no catálogo: ' || pr.status),
    coalesce(v_version, 'sem versão'),
    (pr.attributes ->> 'launched_on')::date,
    'sku',
    pr.business_unit_id,
    pr.brand_id,
    pr.sku,
    'ficha_produto',
    false
  from public.products pr
  join public.brands b on b.id = pr.brand_id;

  select count(*) into v_n from public.knowledge_documents;
  return v_n;
end $$;

revoke execute on function public.rebuild_knowledge() from public, anon, authenticated;
grant execute on function public.rebuild_knowledge() to service_role;

-- ---------------------------------------------------------------------------
-- Busca autorizada. security invoker: a RLS do chamador define o que existe; os filtros abaixo restringem ainda mais
-- (e são a barreira quando o servidor chama com a chave privilegiada).
--  - sem marca/unidade/SKU: só regras do grupo;
--  - com SKU: só a ficha daquele SKU (nunca de outro produto); com marca/unidade: fichas dessa marca/unidade;
--  - vigência avaliada na data do relógio do cenário;
--  - correspondência exata (categoria ou SKU) vem antes do ranking textual;
--  - trechos limitados a p_max_chars (regras críticas curtas voltam inteiras).
-- ---------------------------------------------------------------------------
create function public.search_knowledge(
  p_run       uuid,
  p_query     text,
  p_brand     text default null,
  p_unit      text default null,
  p_sku       text default null,
  p_category  text default null,
  p_limit     integer default 5,
  p_max_chars integer default 600
) returns table (
  id text, kind text, title text, source text, source_ref text, version text,
  valid_from date, valid_to date, scope text, business_unit_id text, brand_id text, sku text,
  category text, critical boolean, exact boolean, all_terms boolean, rank real, snippet text, as_of date
)
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_as_of date;
  v_and tsquery;
  v_or tsquery;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
  v_chars integer := least(greatest(coalesce(p_max_chars, 600), 200), 2000);
begin
  select (r.clock_now at time zone 'America/Sao_Paulo')::date into v_as_of
  from public.scenario_runs r where r.id = p_run;
  if v_as_of is null then
    raise exception 'cenário % não encontrado', p_run;
  end if;

  v_and := plainto_tsquery('public.pt_unaccent', left(coalesce(p_query, ''), 300));
  -- Pergunta em linguagem natural: qualquer termo recupera; quem reúne todos os termos sobe no ranking.
  v_or := replace(v_and::text, ' & ', ' | ')::tsquery;

  return query
  select
    d.id, d.kind, d.title, d.source, d.source_ref, d.version, d.valid_from, d.valid_to, d.scope,
    d.business_unit_id, d.brand_id, d.sku, d.category, d.critical,
    x.exact,
    (numnode(v_and) > 0 and d.search @@ v_and),
    case when numnode(v_or) > 0 then ts_rank_cd(d.search, v_or) else 0 end,
    left(
      case
        when d.critical or length(d.body) <= v_chars or numnode(v_or) = 0 then d.body
        else replace(replace(
          ts_headline('public.pt_unaccent', d.body, v_or,
            'StartSel=<<, StopSel=>>, MaxWords=60, MinWords=20, ShortWord=2, MaxFragments=3, FragmentDelimiter= … '),
          '<<', ''), '>>', '')
      end, v_chars),
    v_as_of
  from public.knowledge_documents d
  cross join lateral (
    select ((p_category is not null and d.category = p_category) or (p_sku is not null and d.sku = p_sku)) as exact
  ) x
  where (d.valid_from is null or d.valid_from <= v_as_of)
    and (d.valid_to is null or d.valid_to >= v_as_of)
    -- escopo pedido
    and (
      d.scope = 'group'
      or (d.kind = 'product' and case when p_sku is not null then d.sku = p_sku
                                      else (d.brand_id = p_brand or d.business_unit_id = p_unit) end)
      or (d.kind = 'policy' and (d.brand_id = p_brand or d.business_unit_id = p_unit))
    )
    -- filtros combinados precisam concordar entre si (SKU de uma marca com outra marca informada não retorna nada)
    and (p_brand is null or d.brand_id is null or d.brand_id = p_brand)
    and (p_unit is null or d.business_unit_id is null or d.business_unit_id = p_unit)
    and (x.exact or (numnode(v_or) > 0 and d.search @@ v_or))
  order by x.exact desc,
           (numnode(v_and) > 0 and d.search @@ v_and) desc,
           d.critical desc,
           case when numnode(v_or) > 0 then ts_rank_cd(d.search, v_or) else 0 end desc,
           d.id
  limit v_limit;
end $$;

revoke execute on function public.search_knowledge(uuid, text, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.search_knowledge(uuid, text, text, text, text, text, integer, integer) to authenticated, service_role;

-- Popula com o que já foi importado (em banco novo, a importação chama rebuild_knowledge ao final).
select public.rebuild_knowledge();
