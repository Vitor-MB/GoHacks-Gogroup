-- GOB-10 · Janela de revisão de duas horas e processamento persistente de tarefas vencidas.
-- A janela só existe para ação que a política já permite executar sem aprovação (decision.reviewWindowAllowed).
-- O timer vive no banco (action_proposals.execute_after + scheduled_tasks), nunca no navegador.
-- As duas horas são configuração proposta do MVP, não regra original da empresa.
-- Funções só para service_role: o servidor informa o funcionário autenticado (ou o sistema, no vencimento).
-- Tempo: vencimento usa o relógio do CENÁRIO (cada execução tem o seu); reserva de tarefa usa o relógio real.

-- ---------------------------------------------------------------------------
-- Tarefas persistidas, reservadas de forma transacional
-- ---------------------------------------------------------------------------
create table public.scheduled_tasks (
  id              uuid primary key default gen_random_uuid(),
  scenario_run_id uuid not null references public.scenario_runs (id) on delete cascade,
  proposal_id     uuid not null references public.action_proposals (id) on delete cascade,
  kind            text not null check (kind in ('janela_revisao')),
  due_at          timestamptz not null,            -- relógio do cenário
  status          text not null default 'pendente' check (status in ('pendente','reservada','concluida','cancelada','falhou')),
  attempts        integer not null default 0,
  lease_until     timestamptz,                     -- relógio real: reserva expirada permite retomada
  retry_at        timestamptz,                     -- relógio real: não retomar antes disso
  locked_by       text,
  last_error      text,
  result          jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index on public.scheduled_tasks (scenario_run_id, due_at) where status in ('pendente','reservada');
-- Uma tarefa ativa por proposta e tipo.
create unique index scheduled_tasks_one_active on public.scheduled_tasks (proposal_id, kind) where status in ('pendente','reservada');

alter table public.scheduled_tasks enable row level security;
grant select on public.scheduled_tasks to authenticated;
create policy tasks_scope on public.scheduled_tasks for select to authenticated
  using (exists (select 1 from public.action_proposals p where p.id = scheduled_tasks.proposal_id));

-- ---------------------------------------------------------------------------
-- Agendar a janela: proposta 'pronta' e elegível vira 'em_janela_revisao' com execute_after.
-- p_message: aviso ao cliente, gravado no outbox só agora que a programação está registrada.
-- ---------------------------------------------------------------------------
create function public.schedule_review_window(p_proposal uuid, p_hours integer, p_message text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_p     public.action_proposals%rowtype;
  v_clock timestamptz;
  v_due   timestamptz;
begin
  select * into v_p from public.action_proposals where id = p_proposal for update;
  if not found then raise exception 'nao_encontrado: proposta inexistente'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 72 then raise exception 'estado_invalido: janela inválida (1 a 72 horas)'; end if;
  if v_p.status = 'em_janela_revisao' then
    return jsonb_build_object('scheduled', false, 'duplicate', true, 'execute_after', v_p.execute_after);
  end if;
  if v_p.status <> 'pronta' then raise exception 'estado_invalido: proposta em % não pode entrar em janela de revisão', v_p.status; end if;
  if exists (select 1 from public.action_executions where proposal_id = p_proposal) then
    raise exception 'estado_invalido: proposta com execução iniciada';
  end if;
  if coalesce((v_p.decision->>'reviewWindowAllowed')::boolean, false) is not true
     or coalesce((v_p.decision->>'approvalRequired')::boolean, false) is true then
    raise exception 'estado_invalido: só ação já autorizada pela política, sem aprovação obrigatória, usa a janela de revisão';
  end if;

  select clock_now into v_clock from public.scenario_runs where id = v_p.scenario_run_id;
  v_due := v_clock + make_interval(hours => p_hours);
  update public.action_proposals set status = 'em_janela_revisao', execute_after = v_due, updated_at = now() where id = p_proposal;
  insert into public.scheduled_tasks (scenario_run_id, proposal_id, kind, due_at) values (v_p.scenario_run_id, p_proposal, 'janela_revisao', v_due);
  perform public.append_audit(v_p.scenario_run_id, v_p.case_id, p_proposal, 'janela_revisao_agendada', 'system', null,
    jsonb_build_object('execute_after', v_due, 'window_hours', p_hours, 'policy_version', v_p.policy_version,
      'action', v_p.action, 'amount_cents', v_p.amount_cents, 'note', 'janela proposta do MVP; vencer não garante execução no segundo exato'),
    v_p.idempotency_key);
  if nullif(p_message, '') is not null then
    insert into public.outbox_events (scenario_run_id, case_id, proposal_id, kind, payload)
    values (v_p.scenario_run_id, v_p.case_id, p_proposal, 'notificacao_cliente',
      jsonb_build_object('text', p_message, 'action', v_p.action, 'stage', 'programada'));
  end if;
  return jsonb_build_object('scheduled', true, 'duplicate', false, 'execute_after', v_due);
end $$;

-- ---------------------------------------------------------------------------
-- Liberar a janela: no vencimento (p_actor nulo = sistema) ou antes, por funcionário autorizado do escopo.
-- p_revalidation: decisão do GOB-06 recalculada agora, sem aprovação. Só libera se continuar executável e elegível ao timer.
-- Idempotente: proposta já liberada/executando/concluída devolve already=true (a execução em si é idempotente no GOB-08).
-- Suspensa por pessoa (e sem aprovação obrigatória) também pode ser retomada por funcionário autorizado.
-- ---------------------------------------------------------------------------
create function public.release_review_window(p_proposal uuid, p_actor uuid, p_revalidation jsonb, p_note text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_p     public.action_proposals%rowtype;
  v_actor public.staff%rowtype;
  v_clock timestamptz;
  v_ok    boolean := coalesce((p_revalidation->>'executable')::boolean, false)
                     and coalesce((p_revalidation->>'reviewWindowAllowed')::boolean, false);
  v_src   text := case when p_actor is null then 'vencimento' else 'liberacao_antecipada' end;
begin
  select * into v_p from public.action_proposals where id = p_proposal for update;
  if not found then raise exception 'nao_encontrado: proposta inexistente'; end if;
  if p_actor is not null then v_actor := public.assert_staff_on_case(p_actor, v_p.case_id); end if;

  if v_p.status in ('pronta','executando','concluida') then
    return jsonb_build_object('released', true, 'already', true, 'status', v_p.status);
  end if;
  if v_p.execute_after is null then raise exception 'estado_invalido: a proposta não tem janela de revisão'; end if;
  if v_p.status not in ('em_janela_revisao','suspensa') or (v_p.status = 'suspensa' and p_actor is null) then
    raise exception 'estado_invalido: proposta em % não pode ser liberada pela janela de revisão', v_p.status;
  end if;
  if coalesce((v_p.decision->>'approvalRequired')::boolean, false) is true then
    raise exception 'estado_invalido: aprovação obrigatória não é liberada pelo timer';
  end if;
  select clock_now into v_clock from public.scenario_runs where id = v_p.scenario_run_id;
  if p_actor is null and v_p.execute_after > v_clock then
    raise exception 'estado_invalido: a janela de revisão ainda não venceu';
  end if;

  if v_ok then
    update public.action_proposals set status = 'pronta', decision = p_revalidation, updated_at = now() where id = p_proposal;
    update public.cases set status = 'em_execucao', decision_requested = null, updated_at = now()
     where id = v_p.case_id and status <> 'resolvido';
    perform public.append_audit(v_p.scenario_run_id, v_p.case_id, p_proposal, 'janela_revisao_liberada',
      case when p_actor is null then 'system' else 'staff' end, p_actor::text,
      jsonb_build_object('source', v_src, 'execute_after', v_p.execute_after, 'scenario_clock', v_clock, 'revalidation', 'ok',
        'role', v_actor.role, 'note', p_note, 'previous_status', v_p.status), v_p.idempotency_key);
    return jsonb_build_object('released', true, 'already', false, 'source', v_src);
  end if;

  -- Dados novos, suspeita, preferência alterada ou pagamento já estornado: não executa e devolve a uma pessoa.
  update public.action_proposals set status = 'bloqueada', decision = p_revalidation, updated_at = now() where id = p_proposal;
  update public.cases set status = 'aguardando_humano', handoff_reason = 'revalidacao_bloqueada',
    decision_requested = 'A revalidação ao fim da janela de revisão bloqueou a execução: revisar os dados do caso', updated_at = now()
   where id = v_p.case_id and status <> 'resolvido';
  perform public.append_audit(v_p.scenario_run_id, v_p.case_id, p_proposal, 'revalidacao_bloqueou',
    case when p_actor is null then 'system' else 'staff' end, p_actor::text,
    jsonb_build_object('source', v_src, 'blockers', p_revalidation->'blockers', 'execute_after', v_p.execute_after), v_p.idempotency_key);
  insert into public.internal_notifications (scenario_run_id, case_id, proposal_id, kind, target_role, title, body, dedupe_key)
  values (v_p.scenario_run_id, v_p.case_id, p_proposal, 'revalidacao_bloqueada', 'supervisor',
    'Janela de revisão: a execução foi bloqueada na revalidação',
    'A revalidação recusou a execução: ' || coalesce(p_revalidation->>'blockers', 'dados alterados'),
    'revalidacao:' || p_proposal || ':v' || v_p.version)
  on conflict (case_id, dedupe_key) do nothing;
  return jsonb_build_object('released', false, 'already', false, 'source', v_src);
end $$;

-- ---------------------------------------------------------------------------
-- Reserva transacional de tarefas vencidas (relógio do cenário de cada execução).
-- Uma única chamada seleciona e reserva (for update skip locked): invocações concorrentes recebem tarefas distintas.
-- Reserva expirada (relógio real) é retomada. Tarefa cuja proposta mudou (suspensa, rejeitada…) é cancelada, não executada.
-- ---------------------------------------------------------------------------
create function public.claim_due_tasks(p_run uuid default null, p_limit integer default 5, p_lease_seconds integer default 120,
  p_worker text default null, p_max_attempts integer default 5) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_t   public.scheduled_tasks%rowtype;
  v_p   public.action_proposals%rowtype;
  v_out jsonb := '[]'::jsonb;
  v_lim integer := greatest(1, least(coalesce(p_limit, 5), 50));
begin
  for v_t in
    select t.* from public.scheduled_tasks t
      join public.scenario_runs r on r.id = t.scenario_run_id
     where (p_run is null or t.scenario_run_id = p_run)
       and t.due_at <= r.clock_now
       and (t.retry_at is null or t.retry_at <= now())
       and (t.status = 'pendente' or (t.status = 'reservada' and t.lease_until < now()))
     order by t.due_at, t.created_at
     limit v_lim
     for update of t skip locked
  loop
    select * into v_p from public.action_proposals where id = v_t.proposal_id;
    if v_p.status = 'concluida' then
      update public.scheduled_tasks set status = 'concluida', finished_at = now(), updated_at = now(), lease_until = null,
        result = jsonb_build_object('motivo', 'efeito já concluído por outro caminho') where id = v_t.id;
    elsif v_p.status not in ('em_janela_revisao','pronta','executando') then
      update public.scheduled_tasks set status = 'cancelada', finished_at = now(), updated_at = now(), lease_until = null,
        result = jsonb_build_object('motivo', 'proposta em ' || v_p.status) where id = v_t.id;
      perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'janela_revisao_cancelada', 'system', null,
        jsonb_build_object('proposal_status', v_p.status, 'note', 'a execução não ocorre: a proposta foi suspensa, rejeitada ou bloqueada antes do vencimento'),
        v_p.idempotency_key);
    elsif v_t.attempts >= p_max_attempts then
      update public.scheduled_tasks set status = 'falhou', finished_at = now(), updated_at = now(), lease_until = null,
        last_error = coalesce(last_error, 'tentativas esgotadas') where id = v_t.id;
      perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'tarefa_falhou', 'system', null,
        jsonb_build_object('attempts', v_t.attempts, 'error', v_t.last_error), v_p.idempotency_key);
      perform public.create_handoff(v_p.scenario_run_id, v_p.case_id, jsonb_build_object(
        'reason', 'execucao_falhou', 'team', 'atendimento', 'proposal_id', v_p.id, 'title', 'O processamento agendado não concluiu',
        'decision_requested', 'Decidir como seguir: a execução agendada falhou após várias tentativas',
        'body', coalesce(v_t.last_error, 'tentativas esgotadas')));
    else
      if v_t.status = 'reservada' then
        perform public.append_audit(v_p.scenario_run_id, v_p.case_id, v_p.id, 'tarefa_retomada', 'system', null,
          jsonb_build_object('attempts', v_t.attempts, 'previous_worker', v_t.locked_by, 'note', 'reserva expirada; execução será reconciliada antes de repetir'),
          v_p.idempotency_key);
      end if;
      update public.scheduled_tasks
         set status = 'reservada', attempts = attempts + 1, locked_by = p_worker, updated_at = now(), retry_at = null,
             lease_until = now() + make_interval(secs => greatest(10, coalesce(p_lease_seconds, 120)))
       where id = v_t.id;
      v_out := v_out || jsonb_build_object('id', v_t.id, 'proposal_id', v_t.proposal_id, 'scenario_run_id', v_t.scenario_run_id,
        'attempt', v_t.attempts + 1, 'due_at', v_t.due_at, 'proposal_status', v_p.status);
    end if;
  end loop;
  return v_out;
end $$;

-- Conclui a tarefa. Só quem a reservou (ou qualquer worker, se a reserva expirou) conclui; repetir é inofensivo.
create function public.complete_task(p_task uuid, p_status text, p_result jsonb default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_t public.scheduled_tasks%rowtype;
begin
  if p_status not in ('concluida','cancelada','falhou') then raise exception 'estado_invalido: status de tarefa inválido'; end if;
  select * into v_t from public.scheduled_tasks where id = p_task for update;
  if not found then raise exception 'nao_encontrado: tarefa inexistente'; end if;
  if v_t.status in ('concluida','cancelada','falhou') then return jsonb_build_object('status', v_t.status, 'already', true); end if;
  update public.scheduled_tasks set status = p_status, result = p_result, lease_until = null, finished_at = now(), updated_at = now()
   where id = p_task;
  return jsonb_build_object('status', p_status, 'already', false);
end $$;

-- Devolve a tarefa à fila (erro ou execução ocupada). p_count=false não consome tentativa (ex.: outra execução em curso).
create function public.retry_task(p_task uuid, p_error text, p_delay_seconds integer default 15, p_count boolean default true) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_t public.scheduled_tasks%rowtype;
begin
  select * into v_t from public.scheduled_tasks where id = p_task for update;
  if not found then raise exception 'nao_encontrado: tarefa inexistente'; end if;
  if v_t.status <> 'reservada' then return jsonb_build_object('status', v_t.status, 'already', true); end if;
  update public.scheduled_tasks
     set status = 'pendente', lease_until = null, locked_by = null, last_error = p_error, updated_at = now(),
         attempts = case when p_count then attempts else greatest(attempts - 1, 0) end,
         retry_at = now() + make_interval(secs => greatest(0, coalesce(p_delay_seconds, 15)))
   where id = p_task;
  return jsonb_build_object('status', 'pendente', 'already', false);
end $$;

revoke execute on function public.schedule_review_window(uuid, integer, text), public.release_review_window(uuid, uuid, jsonb, text),
  public.claim_due_tasks(uuid, integer, integer, text, integer), public.complete_task(uuid, text, jsonb),
  public.retry_task(uuid, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.schedule_review_window(uuid, integer, text), public.release_review_window(uuid, uuid, jsonb, text),
  public.claim_due_tasks(uuid, integer, integer, text, integer), public.complete_task(uuid, text, jsonb),
  public.retry_task(uuid, text, integer, boolean) to service_role;
