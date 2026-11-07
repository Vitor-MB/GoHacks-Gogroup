-- GOB-02 · Funções de acesso (schema private, fora da Data API), RLS e concessões mínimas.

revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- Funcionário ativo vinculado à sessão atual.
create function private.current_staff_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.id from public.staff s where s.auth_user_id = (select auth.uid()) and s.active
$$;

-- O funcionário atual tem algum dos papéis informados?
create function private.has_role(p_roles public.staff_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.auth_user_id = (select auth.uid()) and s.active and s.role = any (p_roles)
  )
$$;

-- Escopo: grupo vê tudo; unidade vê a unidade; marca vê só a marca.
-- Linha sem marca e sem unidade (identidade incerta) só é visível a escopo de grupo.
create function private.can_access(p_unit text, p_brand text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.staff s
    join public.staff_scopes sc on sc.staff_id = s.id
    where s.auth_user_id = (select auth.uid()) and s.active and (
      sc.scope = 'group'
      or (sc.scope = 'unit' and sc.business_unit_id =
            coalesce(p_unit, (select b.business_unit_id from public.brands b where b.id = p_brand)))
      or (sc.scope = 'brand' and sc.brand_id = p_brand)
    )
  )
$$;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- Concessões mínimas: nada para anon; leitura para authenticated (a RLS decide as linhas).
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

grant select on public.business_units, public.brands, public.brand_aliases, public.products,
  public.scenario_runs, public.orders, public.order_items, public.conversations,
  public.messages, public.cases, public.case_conversations, public.staff_scopes to authenticated;
-- CPF não é exposto ao navegador.
grant select (customer_id, full_name, email, phone, birth_date, registered_at, city, uf, zip,
  segment, preferred_channel, accepts_whatsapp, accepts_email, orders_count,
  lifetime_revenue_cents, exchanges_12m, contacts_12m, last_order_on)
  on public.customers to authenticated;
grant select (id, staff_code, full_name, email, role, level, supervisor_id, channels, hired_on, active)
  on public.staff to authenticated;

alter table public.scenario_runs      enable row level security;
alter table public.business_units     enable row level security;
alter table public.brands             enable row level security;
alter table public.brand_aliases      enable row level security;
alter table public.products           enable row level security;
alter table public.customers          enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.conversations      enable row level security;
alter table public.messages           enable row level security;
alter table public.cases              enable row level security;
alter table public.case_conversations enable row level security;
alter table public.staff              enable row level security;
alter table public.staff_scopes       enable row level security;

-- Referência e cenários: qualquer funcionário ativo.
create policy ref_units   on public.business_units for select to authenticated using (private.current_staff_id() is not null);
create policy ref_brands  on public.brands         for select to authenticated using (private.current_staff_id() is not null);
create policy ref_aliases on public.brand_aliases  for select to authenticated using (private.current_staff_id() is not null);
create policy ref_runs    on public.scenario_runs  for select to authenticated using (private.current_staff_id() is not null);

-- Dados por escopo de unidade/marca.
create policy products_scope on public.products for select to authenticated
  using (private.can_access(business_unit_id, brand_id));
create policy orders_scope on public.orders for select to authenticated
  using (private.can_access(business_unit_id, brand_id));
create policy conversations_scope on public.conversations for select to authenticated
  using (private.can_access(business_unit_id, brand_id));
create policy cases_scope on public.cases for select to authenticated
  using (private.can_access(business_unit_id, brand_id));

-- Tabelas filhas herdam o escopo do pai (a RLS do pai se aplica na subconsulta).
create policy order_items_scope on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.order_id = order_items.order_id));
create policy messages_scope on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.conversation_id = messages.conversation_id));
create policy case_conversations_scope on public.case_conversations for select to authenticated
  using (exists (select 1 from public.cases k where k.id = case_conversations.case_id));

-- Cliente visível se algum pedido ou conversa dele estiver no escopo.
create policy customers_scope on public.customers for select to authenticated
  using (
    exists (select 1 from public.orders o where o.customer_id = customers.customer_id)
    or exists (select 1 from public.conversations c where c.customer_id = customers.customer_id)
  );

-- Equipe: cada funcionário vê apenas o próprio registro e os próprios escopos.
create policy staff_self on public.staff for select to authenticated
  using (auth_user_id = (select auth.uid()));
create policy staff_scopes_self on public.staff_scopes for select to authenticated
  using (staff_id = private.current_staff_id());

-- Sem políticas de INSERT/UPDATE/DELETE: escritas ocorrem apenas pelo servidor com a chave privilegiada.
