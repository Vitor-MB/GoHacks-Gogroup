-- GOB-08 · Propostas de ação, execução idempotente (simulada), notificações em outbox e trilha de auditoria.
-- Escritas só pelo servidor (service_role, via RPC). O navegador lê pela RLS herdada do caso.
-- Tudo aqui é SIMULADO: o "sistema externo" é a tabela simulated_operations, que existe para reconciliar resultado incerto.

-- ---------------------------------------------------------------------------
-- Chamados simulados convivem com os importados, isolados por cenário.
-- ---------------------------------------------------------------------------
alter table public.carrier_tickets
  add column scenario_run_id uuid references public.scenario_runs (id) on delete cascade,
  add column simulated boolean not null default false;
create index on public.carrier_tickets (scenario_run_id) where scenario_run_id is not null;

create or replace function public.carrier_tickets_as_of(p_run uuid) returns setof public.carrier_tickets
language sql stable security invoker set search_path = '' as $$
  select t.* from public.carrier_tickets t
  join public.orders_as_of(p_run) o on o.order_id = t.order_id
  where t.opened_at <= (select r.clock_now from public.scenario_runs r where r.id = p_run)
    and (t.scenario_run_id is null or t.scenario_run_id = p_run)
$$;

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------
create table public.action_proposals (
  id               uuid primary key default gen_random_uuid(),
  scenario_run_id  uuid not null references public.scenario_runs (id) on delete cascade,
  case_id          uuid not null references public.cases (id) on delete cascade,
  order_id         text references public.orders (order_id),
  business_unit_id text references public.business_units (id),
  brand_id         text references public.brands (id),
  action           text not null check (action in ('informar_status','abrir_chamado_transportadora','reenviar_produto',
                     'reembolsar','reimprimir_personalizacao','trocar_produto','cancelar_pedido')),
  category         text not null,
  amount_cents     integer check (amount_cents is null or amount_cents >= 0),
  status           text not null check (status in ('proposta','bloqueada','aguardando_aprovacao','em_janela_revisao',
                     'pronta','executando','concluida','falhou','rejeitada','cancelada')),
  idempotency_key  text not null,
  justification    jsonb not null default '[]'::jsonb,  -- motivos verificáveis do motor de políticas
  evidence         jsonb not null default '[]'::jsonb,  -- referências tabela:id consultadas
  policy_version   text,
  decision         jsonb,                               -- saída do GOB-06 (sem cadeia de pensamento do modelo)
  origin           jsonb,                               -- hipótese/fato com status e fontes
  proposed_by      text not null,                       -- ex.: gobia:proxy:glm-5.3
  simulated        boolean not null default true,
  execute_after    timestamptz,                         -- janela de revisão (GOB-10)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (scenario_run_id, idempotency_key)
);
create index on public.action_proposals (case_id);

create table public.action_executions (
  id              uuid primary key default gen_random_uuid(),
  scenario_run_id uuid not null references public.scenario_runs (id) on delete cascade,
  proposal_id     uuid not null unique references public.action_proposals (id) on delete cascade,
  idempotency_key text not null,
  adapter         text not null,
  status          text not null check (status in ('executando','concluida','falhou','incerta')),
  attempt         integer not null default 1,
  max_attempts    integer not null default 3,
  retryable       boolean not null default false,
  external_ref    text,
  result          jsonb,
  error           text,
  started_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz,
  unique (scenario_run_id, idempotency_key)
);

-- Mensagens e avisos só entram aqui na mesma transação que grava o resultado.
create table public.outbox_events (
  id              uuid primary key default gen_random_uuid(),
  scenario_run_id uuid not null references public.scenario_runs (id) on delete cascade,
  case_id         uuid not null references public.cases (id) on delete cascade,
  proposal_id     uuid references public.action_proposals (id) on delete cascade,
  execution_id    uuid references public.action_executions (id) on delete cascade,
  kind            text not null check (kind in ('notificacao_cliente','intervencao_humana')),
  payload         jsonb not null,
  status          text not null default 'pendente' check (status in ('pendente','enviada','falhou')),
  attempts        integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (execution_id, kind)
);
create index on public.outbox_events (case_id);

create table public.audit_events (
  id              bigint generated always as identity primary key,
  scenario_run_id uuid not null references public.scenario_runs (id) on delete cascade,
  case_id         uuid references public.cases (id) on delete cascade,
  proposal_id     uuid references public.action_proposals (id) on delete cascade,
  event_type      text not null,
  actor_type      text not null check (actor_type in ('gobia','staff','system','adapter')),
  actor_id        text,
  simulated       boolean not null default true,
  correlation_id  text,
  data            jsonb not null default '{}'::jsonb,
  scenario_at     timestamptz,                          -- relógio do cenário no momento do evento
  created_at      timestamptz not null default now()
);
create index on public.audit_events (case_id, id);

-- Registro acrescentado: o fluxo comum não reescreve eventos. (Não é imutabilidade criptográfica.)
create function public.audit_events_block_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_events é somente de acréscimo';
end $$;
create trigger audit_events_no_update before update on public.audit_events
  for each row execute function public.audit_events_block_update();

-- "Sistema externo" simulado: uma operação por chave de idempotência, consultável para reconciliação.
create table public.simulated_operations (
  id              uuid primary key default gen_random_uuid(),
  scenario_run_id uuid not null references public.scenario_runs (id) on delete cascade,
  idempotency_key text not null,
  action          text not null,
  external_ref    text not null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (scenario_run_id, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- RLS: leitura herda o escopo do caso; sem políticas de escrita.
-- ---------------------------------------------------------------------------
alter table public.action_proposals     enable row level security;
alter table public.action_executions    enable row level security;
alter table public.outbox_events        enable row level security;
alter table public.audit_events         enable row level security;
alter table public.simulated_operations enable row level security;

grant select on public.action_proposals, public.action_executions, public.outbox_events, public.audit_events to authenticated;

create policy proposals_scope on public.action_proposals for select to authenticated
  using (exists (select 1 from public.cases k where k.id = action_proposals.case_id));
create policy executions_scope on public.action_executions for select to authenticated
  using (exists (select 1 from public.action_proposals p where p.id = action_executions.proposal_id));
create policy outbox_scope on public.outbox_events for select to authenticated
  using (exists (select 1 from public.cases k where k.id = outbox_events.case_id));
create policy audit_scope on public.audit_events for select to authenticated
  using (case_id is not null and exists (select 1 from public.cases k where k.id = audit_events.case_id));
-- simulated_operations: sem concessão nem política para o navegador.

-- ---------------------------------------------------------------------------
-- Auditoria (acréscimo) — usada pelas demais funções e pelo servidor.
-- ---------------------------------------------------------------------------
create function public.append_audit(
  p_run uuid, p_case uuid, p_proposal uuid, p_type text, p_actor_type text, p_actor_id text,
  p_data jsonb, p_correlation text default null
) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.audit_events (scenario_run_id, case_id, proposal_id, event_type, actor_type, actor_id,
    correlation_id, data, scenario_at)
  values (p_run, p_case, p_proposal, p_type, p_actor_type, p_actor_id, p_correlation, coalesce(p_data, '{}'::jsonb),
    (select r.clock_now from public.scenario_runs r where r.id = p_run))
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Proposta: um registro por chave de idempotência (mesma proposta = mesmo registro).
-- p: action, category, order_id, amount_cents, status, idempotency_key, justification, evidence,
--    policy_version, decision, origin, proposed_by
-- ---------------------------------------------------------------------------
create function public.record_proposal(p_run uuid, p_case uuid, p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_case   public.cases%rowtype;
  v_id     uuid;
  v_status text;
  v_key    text := p->>'idempotency_key';
begin
  select * into v_case from public.cases where id = p_case and scenario_run_id = p_run;
  if not found then
    raise exception 'caso % não pertence ao cenário %', p_case, p_run;
  end if;
  if v_case.order_id is distinct from nullif(p->>'order_id', '') then
    raise exception 'pedido da proposta difere do pedido do caso';
  end if;

  insert into public.action_proposals (scenario_run_id, case_id, order_id, business_unit_id, brand_id, action, category,
    amount_cents, status, idempotency_key, justification, evidence, policy_version, decision, origin, proposed_by)
  values (p_run, p_case, v_case.order_id, v_case.business_unit_id, v_case.brand_id, p->>'action', p->>'category',
    nullif(p->>'amount_cents', '')::integer, p->>'status', v_key,
    coalesce(p->'justification', '[]'::jsonb), coalesce(p->'evidence', '[]'::jsonb), p->>'policy_version',
    p->'decision', p->'origin', p->>'proposed_by')
  on conflict (scenario_run_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id, status into v_id, v_status from public.action_proposals
     where scenario_run_id = p_run and idempotency_key = v_key;
    return jsonb_build_object('proposal_id', v_id, 'status', v_status, 'duplicate', true);
  end if;

  perform public.append_audit(p_run, p_case, v_id, 'proposta_registrada', 'gobia', p->>'proposed_by',
    jsonb_build_object('action', p->>'action', 'amount_cents', p->'amount_cents', 'status', p->>'status',
      'policy_version', p->>'policy_version', 'justification', coalesce(p->'justification', '[]'::jsonb),
      'evidence', coalesce(p->'evidence', '[]'::jsonb)), v_key);
  return jsonb_build_object('proposal_id', v_id, 'status', p->>'status', 'duplicate', false);
end $$;

-- ---------------------------------------------------------------------------
-- Reserva de execução. Devolve o que o chamador deve fazer:
--   run (executar), reuse (resultado conhecido), reconcile (consultar o externo antes de repetir),
--   busy (outra execução em curso), failed (tentativas esgotadas ou falha definitiva).
-- ---------------------------------------------------------------------------
create function public.begin_execution(p_proposal uuid, p_adapter text, p_lease_seconds integer default 300,
  p_max_attempts integer default 3) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_p public.action_proposals%rowtype;
  v_e public.action_executions%rowtype;
begin
  select * into v_p from public.action_proposals where id = p_proposal for update;
  if not found then raise exception 'proposta % não encontrada', p_proposal; end if;
  select * into v_e from public.action_executions where proposal_id = p_proposal;

  if found then
    if v_e.status = 'concluida' then
      return jsonb_build_object('mode', 'reuse', 'execution_id', v_e.id, 'attempt', v_e.attempt,
        'external_ref', v_e.external_ref, 'result', v_e.result);
    elsif v_e.status = 'incerta' then
      return jsonb_build_object('mode', 'reconcile', 'execution_id', v_e.id, 'attempt', v_e.attempt);
    elsif v_e.status = 'executando' then
      if v_e.updated_at < now() - make_interval(secs => p_lease_seconds) then
        -- Reserva expirada: não sabemos se o efeito ocorreu. Reconciliar antes de repetir.
        update public.action_executions set status = 'incerta', updated_at = now() where id = v_e.id;
        perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'execucao_reserva_expirada', 'system', null,
          jsonb_build_object('attempt', v_e.attempt), v_p.idempotency_key);
        return jsonb_build_object('mode', 'reconcile', 'execution_id', v_e.id, 'attempt', v_e.attempt);
      end if;
      return jsonb_build_object('mode', 'busy', 'execution_id', v_e.id, 'attempt', v_e.attempt);
    else -- falhou
      if v_e.retryable and v_e.attempt < v_e.max_attempts and v_p.status = 'pronta' then
        update public.action_executions set status = 'executando', attempt = attempt + 1, updated_at = now(),
          error = null where id = v_e.id;
        update public.action_proposals set status = 'executando', updated_at = now() where id = v_p.id;
        perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'execucao_nova_tentativa', 'system', null,
          jsonb_build_object('attempt', v_e.attempt + 1), v_p.idempotency_key);
        return jsonb_build_object('mode', 'run', 'execution_id', v_e.id, 'attempt', v_e.attempt + 1);
      end if;
      return jsonb_build_object('mode', 'failed', 'execution_id', v_e.id, 'attempt', v_e.attempt, 'error', v_e.error);
    end if;
  end if;

  if v_p.status <> 'pronta' then
    raise exception 'proposta % não está pronta para execução (status %)', p_proposal, v_p.status;
  end if;

  insert into public.action_executions (scenario_run_id, proposal_id, idempotency_key, adapter, status, attempt, max_attempts)
  values (v_p.scenario_run_id, v_p.id, 'exec:' || v_p.idempotency_key, p_adapter, 'executando', 1, p_max_attempts)
  returning * into v_e;
  update public.action_proposals set status = 'executando', updated_at = now() where id = v_p.id;
  perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'execucao_iniciada', 'system', null,
    jsonb_build_object('adapter', p_adapter, 'attempt', 1), v_p.idempotency_key);
  return jsonb_build_object('mode', 'run', 'execution_id', v_e.id, 'attempt', 1);
end $$;

-- ---------------------------------------------------------------------------
-- Resultado: grava execução, proposta, caso, chamado simulado, auditoria e outbox numa única transação.
-- p_outcome: status (concluida|falhou|incerta), retryable, external_ref, result, error,
--            notification (texto ao cliente, só em concluida), case_status, ticket {ticket_id, carrier, tracking_code, reason}
-- ---------------------------------------------------------------------------
create function public.finish_execution(p_execution uuid, p_outcome jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_pid    uuid;
  v_p      public.action_proposals%rowtype;
  v_e      public.action_executions%rowtype;
  v_status text := p_outcome->>'status';
  v_retry  boolean := coalesce((p_outcome->>'retryable')::boolean, false);
  v_clock  timestamptz;
  v_ticket jsonb := p_outcome->'ticket';
begin
  select proposal_id into v_pid from public.action_executions where id = p_execution;
  if v_pid is null then raise exception 'execução % não encontrada', p_execution; end if;
  select * into v_p from public.action_proposals where id = v_pid for update;
  select * into v_e from public.action_executions where id = p_execution for update;

  if v_e.status = 'concluida' then
    return jsonb_build_object('status', 'concluida', 'reused', true, 'external_ref', v_e.external_ref, 'result', v_e.result);
  end if;
  if v_e.status not in ('executando', 'incerta') then
    raise exception 'execução % fora de estado (%)', p_execution, v_e.status;
  end if;
  if v_status not in ('concluida', 'falhou', 'incerta') then
    raise exception 'status de resultado inválido: %', v_status;
  end if;
  select clock_now into v_clock from public.scenario_runs where id = v_p.scenario_run_id;

  if v_status = 'concluida' then
    update public.action_executions set status = 'concluida', external_ref = p_outcome->>'external_ref',
      result = p_outcome->'result', error = null, retryable = false, finished_at = now(), updated_at = now()
     where id = v_e.id;
    update public.action_proposals set status = 'concluida', updated_at = now() where id = v_p.id;
    if v_ticket is not null then
      insert into public.carrier_tickets (ticket_id, carrier, order_id, tracking_code, opened_by, opened_at, reason,
        status, scenario_run_id, simulated)
      values (v_ticket->>'ticket_id', v_ticket->>'carrier', v_p.order_id, v_ticket->>'tracking_code', 'gobia',
        v_clock, v_ticket->>'reason', 'aberto', v_p.scenario_run_id, true)
      on conflict (ticket_id) do nothing;
    end if;
    if nullif(p_outcome->>'case_status', '') is not null then
      update public.cases set status = p_outcome->>'case_status', updated_at = now() where id = v_p.case_id;
    end if;
    perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'execucao_concluida', 'adapter', v_e.adapter,
      jsonb_build_object('attempt', v_e.attempt, 'external_ref', p_outcome->>'external_ref', 'result', p_outcome->'result'),
      v_p.idempotency_key);
    if nullif(p_outcome->>'notification', '') is not null then
      insert into public.outbox_events (scenario_run_id, case_id, proposal_id, execution_id, kind, payload)
      values (v_p.scenario_run_id, v_p.case_id, v_p.id, v_e.id, 'notificacao_cliente',
        jsonb_build_object('text', p_outcome->>'notification', 'action', v_p.action))
      on conflict (execution_id, kind) do nothing;
    end if;
    return jsonb_build_object('status', 'concluida', 'reused', false, 'external_ref', p_outcome->>'external_ref');

  elsif v_status = 'incerta' then
    update public.action_executions set status = 'incerta', error = p_outcome->>'error', updated_at = now() where id = v_e.id;
    perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'execucao_incerta', 'adapter', v_e.adapter,
      jsonb_build_object('attempt', v_e.attempt, 'error', p_outcome->>'error'), v_p.idempotency_key);
    return jsonb_build_object('status', 'incerta');

  elsif v_retry and v_e.attempt < v_e.max_attempts then
    update public.action_executions set status = 'falhou', retryable = true, error = p_outcome->>'error', updated_at = now()
     where id = v_e.id;
    update public.action_proposals set status = 'pronta', updated_at = now() where id = v_p.id;
    perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'execucao_falha_transitoria', 'adapter', v_e.adapter,
      jsonb_build_object('attempt', v_e.attempt, 'error', p_outcome->>'error'), v_p.idempotency_key);
    return jsonb_build_object('status', 'falhou', 'retryable', true, 'attempt', v_e.attempt);

  else
    update public.action_executions set status = 'falhou', retryable = false, error = p_outcome->>'error',
      finished_at = now(), updated_at = now() where id = v_e.id;
    update public.action_proposals set status = 'falhou', updated_at = now() where id = v_p.id;
    update public.cases set status = 'aguardando_humano', updated_at = now() where id = v_p.case_id;
    perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'execucao_falhou', 'adapter', v_e.adapter,
      jsonb_build_object('attempt', v_e.attempt, 'error', p_outcome->>'error'), v_p.idempotency_key);
    insert into public.outbox_events (scenario_run_id, case_id, proposal_id, execution_id, kind, payload)
    values (v_p.scenario_run_id, v_p.case_id, v_p.id, v_e.id, 'intervencao_humana',
      jsonb_build_object('error', p_outcome->>'error', 'action', v_p.action, 'attempts', v_e.attempt))
    on conflict (execution_id, kind) do nothing;
    return jsonb_build_object('status', 'falhou', 'retryable', false, 'attempt', v_e.attempt);
  end if;
end $$;

revoke execute on function public.append_audit(uuid, uuid, uuid, text, text, text, jsonb, text),
  public.record_proposal(uuid, uuid, jsonb), public.begin_execution(uuid, text, integer, integer),
  public.finish_execution(uuid, jsonb), public.audit_events_block_update()
  from public, anon, authenticated;
grant execute on function public.append_audit(uuid, uuid, uuid, text, text, text, jsonb, text),
  public.record_proposal(uuid, uuid, jsonb), public.begin_execution(uuid, text, integer, integer),
  public.finish_execution(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Reset passa a limpar também chamados simulados e o "sistema externo" do cenário.
-- Propostas, execuções, outbox e auditoria saem junto com os casos (cascata).
-- ---------------------------------------------------------------------------
create or replace function public.reset_scenario_run(p_run uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.scenario_runs where id = p_run) then
    raise exception 'cenário % não encontrado', p_run;
  end if;
  delete from public.simulated_operations where scenario_run_id = p_run;
  delete from public.carrier_tickets where scenario_run_id = p_run;
  delete from public.contact_events where scenario_run_id = p_run;
  delete from public.cases where scenario_run_id = p_run;
  delete from public.conversations where scenario_run_id = p_run;
  update public.scenario_runs set clock_now = clock_start where id = p_run;
end $$;
