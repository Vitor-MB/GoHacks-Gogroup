-- Resiliência quando a IA está fora do ar: tarefa de investigação durável com retentativa, disjuntor (circuit breaker)
-- no banco e confirmação de recebimento ao cliente que NÃO depende do modelo.
-- Regras preservadas: nada aqui aprova, executa ou promete resultado. Esgotado o prazo, o caso vai para uma pessoa
-- (motivo 'ia_indisponivel'). Retentativa e reservas usam o relógio REAL (infraestrutura); o relógio do cenário segue
-- valendo para prazos de negócio. Funções só para service_role.

-- ---------------------------------------------------------------------------
-- Confirmação de recebimento: o outbox ganha chave de deduplicação por caso.
-- ---------------------------------------------------------------------------
alter table public.outbox_events add column dedupe_key text;
create unique index outbox_events_case_dedupe on public.outbox_events (case_id, dedupe_key) where dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- Tarefa de investigação: uma por caso, reservada de forma transacional, com prazo para desistir (relógio real).
-- ---------------------------------------------------------------------------
create table public.investigation_tasks (
  id              uuid primary key default gen_random_uuid(),
  scenario_run_id uuid not null references public.scenario_runs (id) on delete cascade,
  case_id         uuid not null references public.cases (id) on delete cascade,
  status          text not null default 'pendente' check (status in ('pendente','reservada','concluida','degradada','cancelada')),
  attempts        integer not null default 0,
  lease_until     timestamptz,
  retry_at        timestamptz,
  locked_by       text,
  last_error      text,
  last_error_kind text,
  deadline_at     timestamptz not null,            -- depois dele, sem IA, o caso vai para uma pessoa
  result          jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create unique index investigation_tasks_one_per_case on public.investigation_tasks (case_id);
create index on public.investigation_tasks (status, retry_at) where status in ('pendente','reservada');
alter table public.investigation_tasks enable row level security;
grant select on public.investigation_tasks to authenticated;
create policy investigation_tasks_scope on public.investigation_tasks for select to authenticated
  using (exists (select 1 from public.cases k where k.id = investigation_tasks.case_id));

-- ---------------------------------------------------------------------------
-- Disjuntor do provedor de IA. Estado no banco porque o servidor é efêmero. Conta falhas consecutivas de disponibilidade.
-- closed → open após N falhas; open → half_open depois da espera (UMA chamada de prova); prova ok fecha, prova falha reabre.
-- ---------------------------------------------------------------------------
create table public.ai_circuit (
  name              text primary key,
  state             text not null default 'closed' check (state in ('closed','open','half_open')),
  failures          integer not null default 0,
  opened_at         timestamptz,
  probe_started_at  timestamptz,
  last_failure_at   timestamptz,
  last_error_kind   text,
  updated_at        timestamptz not null default now()
);
alter table public.ai_circuit enable row level security;
grant select on public.ai_circuit to authenticated;   -- só estado operacional, sem segredo
create policy ai_circuit_read on public.ai_circuit for select to authenticated using (true);

create function public.ai_circuit_check(p_name text, p_cooldown_seconds integer default 60) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v public.ai_circuit%rowtype;
  v_wait integer;
begin
  insert into public.ai_circuit (name) values (p_name) on conflict do nothing;
  select * into v from public.ai_circuit where name = p_name for update;
  if v.state = 'closed' then
    return jsonb_build_object('allow', true, 'state', 'closed', 'probe', false, 'retry_in_seconds', 0);
  end if;
  if v.state = 'open' then
    v_wait := ceil(extract(epoch from (v.opened_at + make_interval(secs => p_cooldown_seconds) - now())))::integer;
    if v_wait <= 0 then
      update public.ai_circuit set state = 'half_open', probe_started_at = now(), updated_at = now() where name = p_name;
      return jsonb_build_object('allow', true, 'state', 'half_open', 'probe', true, 'retry_in_seconds', 0);
    end if;
    return jsonb_build_object('allow', false, 'state', 'open', 'probe', false, 'retry_in_seconds', v_wait);
  end if;
  -- half_open: só uma prova por vez; prova perdida (processo morreu) é refeita após a espera.
  v_wait := ceil(extract(epoch from (v.probe_started_at + make_interval(secs => p_cooldown_seconds) - now())))::integer;
  if v_wait <= 0 then
    update public.ai_circuit set probe_started_at = now(), updated_at = now() where name = p_name;
    return jsonb_build_object('allow', true, 'state', 'half_open', 'probe', true, 'retry_in_seconds', 0);
  end if;
  return jsonb_build_object('allow', false, 'state', 'half_open', 'probe', false, 'retry_in_seconds', v_wait);
end $$;

create function public.ai_circuit_record(p_name text, p_ok boolean, p_error_kind text default null, p_threshold integer default 3) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v public.ai_circuit%rowtype;
begin
  insert into public.ai_circuit (name) values (p_name) on conflict do nothing;
  select * into v from public.ai_circuit where name = p_name for update;
  if p_ok then
    update public.ai_circuit set state = 'closed', failures = 0, opened_at = null, probe_started_at = null, updated_at = now() where name = p_name;
    return jsonb_build_object('state', 'closed', 'failures', 0, 'recovered', v.state <> 'closed');
  end if;
  if v.state = 'half_open' or v.failures + 1 >= greatest(coalesce(p_threshold, 3), 1) then
    update public.ai_circuit set state = 'open', failures = v.failures + 1, opened_at = now(), probe_started_at = null,
      last_failure_at = now(), last_error_kind = p_error_kind, updated_at = now() where name = p_name;
    return jsonb_build_object('state', 'open', 'failures', v.failures + 1, 'opened', v.state <> 'open');
  end if;
  update public.ai_circuit set failures = v.failures + 1, last_failure_at = now(), last_error_kind = p_error_kind, updated_at = now() where name = p_name;
  return jsonb_build_object('state', v.state, 'failures', v.failures + 1, 'opened', false);
end $$;

-- ---------------------------------------------------------------------------
-- Agendar a investigação e enfileirar a confirmação de recebimento. Idempotente por caso.
-- A confirmação só diz que o contato foi recebido; não promete resultado, prazo de solução nem ação.
-- ---------------------------------------------------------------------------
create function public.enqueue_investigation(p_run uuid, p_case uuid, p_ack text, p_deadline_minutes integer default 30) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_case  public.cases%rowtype;
  v_task  uuid;
  v_ack   uuid;
begin
  select * into v_case from public.cases where id = p_case and scenario_run_id = p_run for update;
  if not found then raise exception 'nao_encontrado: caso % não pertence ao cenário %', p_case, p_run; end if;
  if p_deadline_minutes is null or p_deadline_minutes < 1 or p_deadline_minutes > 1440 then
    raise exception 'estado_invalido: prazo inválido (1 a 1440 minutos)';
  end if;

  insert into public.investigation_tasks (scenario_run_id, case_id, deadline_at)
  values (p_run, p_case, now() + make_interval(mins => p_deadline_minutes))
  on conflict (case_id) do nothing
  returning id into v_task;

  insert into public.outbox_events (scenario_run_id, case_id, kind, payload, dedupe_key)
  values (p_run, p_case, 'notificacao_cliente',
    jsonb_build_object('tipo', 'confirmacao_recebimento', 'message', p_ack, 'automatica', true), 'confirmacao_recebimento')
  on conflict (case_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_ack;

  if v_task is not null then
    perform public.append_audit(p_run, p_case, null, 'investigacao_agendada', 'system', null,
      jsonb_build_object('task_id', v_task, 'deadline_minutes', p_deadline_minutes), 'caso:' || p_case);
  end if;
  if v_ack is not null then
    perform public.append_audit(p_run, p_case, null, 'confirmacao_recebimento_enfileirada', 'system', null,
      jsonb_build_object('outbox_id', v_ack, 'note', 'confirmação automática de recebimento; não informa resultado'), 'caso:' || p_case);
  end if;
  return jsonb_build_object('task_id', v_task, 'task_created', v_task is not null, 'ack_id', v_ack, 'ack_created', v_ack is not null);
end $$;

-- Contato + agendamento na MESMA transação: não existe caso novo sem tarefa e sem confirmação.
-- Caso novo que precisa de esclarecimento não é investigado (continua a regra do GOB-04).
create function public.record_contact_and_enqueue(p_run uuid, p_event jsonb, p_ctx jsonb, p_ack text, p_deadline_minutes integer default 30) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_res jsonb;
  v_enq jsonb;
begin
  v_res := public.record_contact(p_run, p_event, p_ctx);
  if coalesce((v_res->>'duplicate')::boolean, false) is false
     and coalesce((v_res->>'new_case')::boolean, false) is true
     and coalesce((v_res->>'needs_clarification')::boolean, false) is false then
    v_enq := public.enqueue_investigation(p_run, (v_res->>'case_id')::uuid, p_ack, p_deadline_minutes);
    v_res := v_res || jsonb_build_object('investigation_task_id', v_enq->'task_id', 'ack_queued', (v_enq->>'ack_created')::boolean);
    update public.contact_events set result = v_res where scenario_run_id = p_run and channel = p_event->>'channel'
       and external_event_id = p_event->>'external_event_id';
  end if;
  return v_res;
end $$;

-- ---------------------------------------------------------------------------
-- Reserva transacional (skip locked). Reserva expirada é retomada. Prazo ou tentativas esgotados SEM IA:
-- o caso vai para uma pessoa com motivo 'ia_indisponivel' (nenhuma proposta, aprovação ou execução é criada).
-- ---------------------------------------------------------------------------
create function public.claim_investigation_tasks(p_limit integer default 5, p_lease_seconds integer default 120,
  p_worker text default null, p_max_attempts integer default 5) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_t    public.investigation_tasks%rowtype;
  v_case public.cases%rowtype;
  v_out  jsonb := '[]'::jsonb;
  v_lim  integer := greatest(1, least(coalesce(p_limit, 5), 50));
begin
  for v_t in
    select t.* from public.investigation_tasks t
     where (t.retry_at is null or t.retry_at <= now())
       and (t.status = 'pendente' or (t.status = 'reservada' and t.lease_until < now()))
     order by t.created_at
     limit v_lim
     for update of t skip locked
  loop
    select * into v_case from public.cases where id = v_t.case_id;
    if v_case.status = 'resolvido' then
      update public.investigation_tasks set status = 'cancelada', finished_at = now(), updated_at = now(), lease_until = null,
        result = jsonb_build_object('motivo', 'caso já resolvido') where id = v_t.id;
    elsif v_t.attempts >= p_max_attempts or now() > v_t.deadline_at then
      update public.investigation_tasks set status = 'degradada', finished_at = now(), updated_at = now(), lease_until = null,
        result = jsonb_build_object('motivo', case when now() > v_t.deadline_at then 'prazo esgotado sem IA' else 'tentativas esgotadas' end,
          'attempts', v_t.attempts, 'last_error_kind', v_t.last_error_kind) where id = v_t.id;
      perform public.append_audit(v_t.scenario_run_id, v_t.case_id, null, 'investigacao_degradada', 'system', null,
        jsonb_build_object('task_id', v_t.id, 'attempts', v_t.attempts, 'error_kind', v_t.last_error_kind,
          'note', 'IA indisponível: caso encaminhado a uma pessoa; nenhuma ação foi proposta, aprovada ou executada'), 'caso:' || v_t.case_id);
      perform public.create_handoff(v_t.scenario_run_id, v_t.case_id, jsonb_build_object(
        'reason', 'ia_indisponivel', 'team', 'atendimento', 'title', 'IA indisponível: o caso precisa de uma pessoa',
        'decision_requested', 'Assumir o atendimento e investigar manualmente; a GoBIA não conseguiu analisar o caso a tempo',
        'body', 'Tentativas: ' || v_t.attempts || '. Último erro: ' || coalesce(v_t.last_error_kind, 'indisponibilidade da IA')));
    else
      update public.investigation_tasks set status = 'reservada', attempts = attempts + 1, lease_until = now() + make_interval(secs => p_lease_seconds),
        locked_by = p_worker, updated_at = now() where id = v_t.id returning * into v_t;
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_t.id, 'scenario_run_id', v_t.scenario_run_id, 'case_id', v_t.case_id,
        'attempt', v_t.attempts, 'deadline_at', v_t.deadline_at));
    end if;
  end loop;
  return v_out;
end $$;

create function public.complete_investigation_task(p_task uuid, p_status text, p_result jsonb default null) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_status not in ('concluida','cancelada') then raise exception 'estado_invalido: situação final inválida'; end if;
  update public.investigation_tasks set status = p_status, finished_at = now(), updated_at = now(), lease_until = null, result = p_result
   where id = p_task and status = 'reservada';
  if not found then raise exception 'estado_invalido: tarefa não está reservada'; end if;
end $$;

-- Devolve a tarefa à fila. p_count=false não consome tentativa (ex.: disjuntor aberto: a IA nem foi chamada).
create function public.retry_investigation_task(p_task uuid, p_error text, p_error_kind text, p_delay_seconds integer, p_count boolean default true) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  update public.investigation_tasks set status = 'pendente', lease_until = null, locked_by = null,
    retry_at = now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0)),
    attempts = case when p_count then attempts else greatest(attempts - 1, 0) end,
    last_error = left(p_error, 300), last_error_kind = p_error_kind, updated_at = now()
   where id = p_task and status = 'reservada';
  if not found then raise exception 'estado_invalido: tarefa não está reservada'; end if;
end $$;

revoke execute on function public.ai_circuit_check(text, integer), public.ai_circuit_record(text, boolean, text, integer),
  public.enqueue_investigation(uuid, uuid, text, integer), public.record_contact_and_enqueue(uuid, jsonb, jsonb, text, integer),
  public.claim_investigation_tasks(integer, integer, text, integer), public.complete_investigation_task(uuid, text, jsonb),
  public.retry_investigation_task(uuid, text, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.ai_circuit_check(text, integer), public.ai_circuit_record(text, boolean, text, integer),
  public.enqueue_investigation(uuid, uuid, text, integer), public.record_contact_and_enqueue(uuid, jsonb, jsonb, text, integer),
  public.claim_investigation_tasks(integer, integer, text, integer), public.complete_investigation_task(uuid, text, jsonb),
  public.retry_investigation_task(uuid, text, text, integer, boolean) to service_role;
