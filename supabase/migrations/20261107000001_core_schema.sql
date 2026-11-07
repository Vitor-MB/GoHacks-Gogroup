-- GOB-02 · Schema base: catálogo, pedidos, conversas, casos, equipe e permissões.
-- Valores monetários em centavos. Timestamps em timestamptz (a base está em America/Sao_Paulo, UTC-3).
-- Dados de origem têm scenario_run_id nulo; registros produzidos pela GoBIA carregam a execução do cenário.

create schema if not exists private;

create type public.staff_role as enum ('atendente', 'analista', 'supervisor');
create type public.scope_type as enum ('group', 'unit', 'brand');

-- Execuções de cenário (isolamento de demonstração, previews e jobs). Relógio detalhado na GOB-03.
create table public.scenario_runs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  mode        text not null default 'demo' check (mode in ('dev', 'demo', 'preview')),
  clock_start timestamptz not null default '2026-11-02 08:00:00-03',
  clock_now   timestamptz not null default '2026-11-02 08:00:00-03',
  created_at  timestamptz not null default now()
);

-- Unidades, marcas e aliases
create table public.business_units (
  id   text primary key,
  name text not null unique
);
create table public.brands (
  id               text primary key,
  name             text not null unique,
  business_unit_id text not null references public.business_units (id)
);
create table public.brand_aliases (
  alias    text primary key check (alias = lower(alias)),
  brand_id text not null references public.brands (id) on delete cascade
);
create index on public.brands (business_unit_id);

-- Catálogo
create table public.products (
  sku                  text primary key,
  name                 text not null,
  brand_id             text not null references public.brands (id),
  business_unit_id     text not null references public.business_units (id),
  category             text,
  kind                 text,
  price_cents          integer,
  cost_cents           integer,
  personalizable       boolean not null default false,
  personalization_type text,
  production_days      integer,
  composition          text,
  usage_instructions   text,
  warnings             text,
  shelf_life_months    integer,
  anvisa_registry      text,
  ean                  text,
  status               text,
  attributes           jsonb not null default '{}'::jsonb
);
create index on public.products (brand_id);
create index on public.products (business_unit_id);

-- Clientes
create table public.customers (
  customer_id            text primary key,
  full_name              text,
  email                  text,
  phone                  text,
  cpf                    text,
  birth_date             date,
  registered_at          timestamptz,
  city                   text,
  uf                     text,
  zip                    text,
  segment                text,
  preferred_channel      text,
  accepts_whatsapp       boolean,
  accepts_email          boolean,
  orders_count           integer,
  lifetime_revenue_cents bigint,
  exchanges_12m          integer,
  contacts_12m           integer,
  last_order_on          date
);

-- Pedidos e itens
create table public.orders (
  order_id             text primary key,
  customer_id          text not null references public.customers (customer_id),
  brand_id             text not null references public.brands (id),
  business_unit_id     text not null references public.business_units (id),
  ordered_at           timestamptz not null,
  total_cents          integer not null,
  sku                  text references public.products (sku),
  product_description  text,
  personalization      text,
  carrier              text,
  uf                   text,
  delivery_status      text check (delivery_status in
    ('aguardando_separacao','em_transito','entregue','extraviado','devolvido','cancelado')),
  separated_at         timestamptz,
  fulfillment_center   text,
  print_machine        text,
  delivered_on         date,
  product_lot          text,
  sales_channel        text,
  items_count          integer,
  products_total_cents integer,
  discount_cents       integer,
  coupon               text,
  shipping_cents       integer,
  payment_method       text,
  installments         integer,
  payment_status       text,
  promised_on          date,
  tracking_code        text,
  invoice_number       text,
  delivery_zip         text,
  delivery_city        text
);
create index on public.orders (customer_id);
create index on public.orders (brand_id);
create index on public.orders (business_unit_id);

create table public.order_items (
  item_id              text primary key,
  order_id             text not null references public.orders (order_id) on delete cascade,
  line                 integer not null,
  sku                  text references public.products (sku),
  description          text,
  item_type            text,
  quantity             integer not null,
  unit_price_cents     integer,
  discount_cents       integer,
  total_cents          integer,
  personalization      text,
  personalization_text text,
  lot                  text,
  unique (order_id, line)
);

-- Conversas e mensagens
create table public.conversations (
  conversation_id   text primary key,
  customer_id       text not null references public.customers (customer_id),
  order_id          text references public.orders (order_id),
  brand_id          text references public.brands (id),
  business_unit_id  text references public.business_units (id),
  channel           text not null check (channel in ('whatsapp', 'email', 'reclame_aqui')),
  origin            text not null check (origin in ('historico', 'fila', 'simulado')),
  external_id       text,
  opened_at         timestamptz not null,
  status            text,
  agent_tag         text,
  subject           text,
  agent_code        text,
  first_response_at timestamptz,
  closed_at         timestamptz,
  csat              smallint,
  interactions      integer,
  scenario_run_id   uuid references public.scenario_runs (id) on delete cascade
);
create index on public.conversations (customer_id);
create index on public.conversations (order_id);
create index on public.conversations (brand_id);
create index on public.conversations (scenario_run_id);
create unique index conversations_channel_external_uq
  on public.conversations (channel, external_id) where external_id is not null;

create table public.messages (
  message_id      text primary key,
  conversation_id text not null references public.conversations (conversation_id) on delete cascade,
  author          text not null check (author in ('cliente', 'agente', 'bot')),
  sent_at         timestamptz not null,
  body            text
);
create index on public.messages (conversation_id, sent_at);

-- Casos operacionais
create table public.cases (
  id               uuid primary key default gen_random_uuid(),
  scenario_run_id  uuid not null references public.scenario_runs (id) on delete cascade,
  customer_id      text not null references public.customers (customer_id),
  order_id         text references public.orders (order_id),
  business_unit_id text references public.business_units (id),
  brand_id         text references public.brands (id),
  status           text not null default 'novo' check (status in
    ('novo','em_investigacao','aguardando_cliente','aguardando_humano',
     'aguardando_terceiro','em_execucao','resolvido','reaberto')),
  summary          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on public.cases (scenario_run_id);
create index on public.cases (customer_id);
create index on public.cases (order_id);

create table public.case_conversations (
  case_id         uuid not null references public.cases (id) on delete cascade,
  conversation_id text not null references public.conversations (conversation_id) on delete cascade,
  primary key (case_id, conversation_id)
);
create index on public.case_conversations (conversation_id);

-- Equipe e permissões (controladas pelo servidor; nunca por user_metadata)
create table public.staff (
  id            uuid primary key default gen_random_uuid(),
  staff_code    text unique,
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  full_name     text not null,
  email         text not null unique,
  role          public.staff_role not null,
  level         text,
  supervisor_id uuid references public.staff (id),
  channels      text[] not null default '{}',
  hired_on      date,
  active        boolean not null default true
);

create table public.staff_scopes (
  id               uuid primary key default gen_random_uuid(),
  staff_id         uuid not null references public.staff (id) on delete cascade,
  scope            public.scope_type not null,
  business_unit_id text references public.business_units (id),
  brand_id         text references public.brands (id),
  check (
    (scope = 'group' and business_unit_id is null and brand_id is null) or
    (scope = 'unit'  and business_unit_id is not null and brand_id is null) or
    (scope = 'brand' and brand_id is not null and business_unit_id is null)
  ),
  unique nulls not distinct (staff_id, scope, business_unit_id, brand_id)
);
create index on public.staff_scopes (staff_id);
