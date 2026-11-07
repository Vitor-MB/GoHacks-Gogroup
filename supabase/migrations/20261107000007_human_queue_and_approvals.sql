-- GOB-09 · Fila humana: responsável, encaminhamento, notificações internas e aprovação vinculada à versão da proposta.
-- Toda decisão é validada AQUI (papel, escopo, solicitante x aprovador, versão, valor), mesmo que o chamador já tenha conferido.
-- As funções só executam para service_role; o servidor informa o funcionário autenticado, nunca o navegador.
-- Prazo de aprovação: NÃO consta em BD/politicas.csv. O valor padrão (24 h do relógio do cenário) é premissa do MVP.

-- ---------------------------------------------------------------------------
-- Colunas novas
-- ---------------------------------------------------------------------------
alter table public.cases
  add column assigned_to       uuid references public.staff (id) on delete set null,
  add column assignee_name     text,
  add column assigned_at       timestamptz,
  add column handoff_reason    text,
  add column handoff_team      text,
  add column decision_requested text;
create index on public.cases (assigned_to) where assigned_to is not null;

alter table public.action_proposals
  add column version          integer not null default 1,
  add column requested_by     uuid references public.staff (id) on delete set null, -- humano que pediu/ajustou a proposta
  add column approval_due_at  timestamptz,
  add column escalation_level integer not null default 0,
  add column facts_snapshot   jsonb;  -- fatos verificados na proposta; a revalidação reaproveita o que o banco não informa

alter table public.action_proposals drop constraint action_proposals_status_check;
alter table public.action_proposals add constraint action_proposals_status_check check (status in
  ('proposta','bloqueada','aguardando_aprovacao','em_janela_revisao','pronta','executando','concluida','falhou',
   'rejeitada','cancelada','suspensa'));

-- ---------------------------------------------------------------------------
-- Decisões humanas e notificações internas
-- ---------------------------------------------------------------------------
create table public.proposal_approvals (
  id               uuid primary key default gen_random_uuid(),
  scenario_run_id  uuid not null references public.scenario_runs (id) on delete cascade,
  proposal_id      uuid not null references public.action_proposals (id) on delete cascade,
  proposal_version integer not null,
  order_id         text,
  action           text not null,
  amount_cents     integer,
  decision         text not null check (decision in ('aprovada','rejeitada','suspensa')),
  decided_by       uuid not null references public.staff (id),
  decided_role     public.staff_role not null,
  note             text,
  decided_at       timestamptz not null default now(),
  scenario_at      timestamptz,
  superseded_at    timestamptz,
  superseded_reason text
);
create index on public.proposal_approvals (proposal_id);
-- No máximo uma aprovação vigente por proposta.
create unique index proposal_approvals_one_active on public.proposal_approvals (proposal_id)
  where decision = 'aprovada' and superseded_at is null;

create table public.internal_notifications (
  id              uuid primary key default gen_random_uuid(),
  scenario_run_id uuid not null references public.scenario_runs (id) on delete cascade,
  case_id         uuid not null references public.cases (id) on delete cascade,
  proposal_id     uuid references public.action_proposals (id) on delete cascade,
  kind            text not null check (kind in ('encaminhamento','aprovacao_solicitada','aprovacao_cobrada',
                    'aprovacao_escalonada','atribuicao','continuidade_humana','proposta_suspensa','proposta_ajustada',
                    'revalidacao_bloqueada')),
  target_role     public.staff_role,
  target_staff_id uuid references public.staff (id) on delete cascade,
  title           text not null,
  body            text not null,
  dedupe_key      text not null,
  status          text not null default 'pendente' check (status in ('pendente','lida')),
  created_at      timestamptz not null default now(),
  read_at         timestamptz,
  unique (case_id, dedupe_key)
);
create index on public.internal_notifications (case_id);

alter table public.proposal_approvals    enable row level security;
alter table public.internal_notifications enable row level security;
grant select on public.proposal_approvals, public.internal_notifications to authenticated;

create policy approvals_scope on public.proposal_approvals for select to authenticated
  using (exists (select 1 from public.action_proposals p where p.id = proposal_approvals.proposal_id));
-- Notificação: no escopo do caso e dirigida ao funcionário/papel (supervisor enxerga todas do seu escopo).
create policy notifications_scope on public.internal_notifications for select to authenticated
  using (
    exists (select 1 from public.cases k where k.id = internal_notifications.case_id)
    and (target_staff_id is null or target_staff_id = private.current_staff_id())
    and (target_role is null or private.has_role(array[target_role, 'supervisor'::public.staff_role]))
  );

-- ---------------------------------------------------------------------------
-- Apoio: escopo de um funcionário específico (espelha private.can_access, que usa auth.uid()).
-- ---------------------------------------------------------------------------
create function public.staff_has_scope(p_staff uuid, p_unit text, p_brand text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1
    from public.staff s
    join public.staff_scopes sc on sc.staff_id = s.id
    where s.id = p_staff and s.active and (
      sc.scope = 'group'
      or (sc.scope = 'unit' and sc.business_unit_id =
            coalesce(p_unit, (select b.business_unit_id from public.brands b where b.id = p_brand)))
      or (sc.scope = 'brand' and sc.brand_id = p_brand)
    )
  )
$$;

-- Funcionário ativo e no escopo do caso; devolve o registro ou levanta erro com código.
create function public.assert_staff_on_case(p_staff uuid, p_case uuid) returns public.staff
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_s public.staff%rowtype;
  v_c public.cases%rowtype;
begin
  select * into v_s from public.staff where id = p_staff and active;
  if not found then raise exception 'nao_autorizado: funcionário inexistente ou inativo'; end if;
  select * into v_c from public.cases where id = p_case;
  if not found then raise exception 'nao_encontrado: caso inexistente'; end if;
  if not public.staff_has_scope(p_staff, v_c.business_unit_id, v_c.brand_id) then
    raise exception 'fora_do_escopo: o caso está fora do escopo do funcionário';
  end if;
  return v_s;
end $$;

-- ---------------------------------------------------------------------------
-- record_proposal: passa a aceitar `requested_by` (humano que pediu a proposta). Demais regras iguais à GOB-08.
-- ---------------------------------------------------------------------------
create or replace function public.record_proposal(p_run uuid, p_case uuid, p jsonb) returns jsonb
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
    amount_cents, status, idempotency_key, justification, evidence, policy_version, decision, origin, proposed_by, requested_by, facts_snapshot)
  values (p_run, p_case, v_case.order_id, v_case.business_unit_id, v_case.brand_id, p->>'action', p->>'category',
    nullif(p->>'amount_cents', '')::integer, p->>'status', v_key,
    coalesce(p->'justification', '[]'::jsonb), coalesce(p->'evidence', '[]'::jsonb), p->>'policy_version',
    p->'decision', p->'origin', p->>'proposed_by', nullif(p->>'requested_by', '')::uuid, p->'facts')
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
-- Encaminhamento: motivo, equipe, decisão solicitada e notificação interna persistida (idempotente).
-- p: reason, team, decision_requested, proposal_id?, target_role?, title?, body?, approval_due_hours?
-- ---------------------------------------------------------------------------
create function public.create_handoff(p_run uuid, p_case uuid, p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_case   public.cases%rowtype;
  v_prop   uuid := nullif(p->>'proposal_id', '')::uuid;
  v_reason text := coalesce(nullif(p->>'reason', ''), 'encaminhamento');
  v_kind   text := case when v_prop is not null and coalesce(p->>'target_role', '') = 'supervisor'
                        then 'aprovacao_solicitada' else 'encaminhamento' end;
  v_clock  timestamptz;
  v_notif  uuid;
begin
  select * into v_case from public.cases where id = p_case and scenario_run_id = p_run for update;
  if not found then raise exception 'caso % não pertence ao cenário %', p_case, p_run; end if;
  select clock_now into v_clock from public.scenario_runs where id = p_run;

  if v_case.status <> 'resolvido' then
    update public.cases set status = 'aguardando_humano', handoff_reason = v_reason, handoff_team = p->>'team',
      decision_requested = p->>'decision_requested', updated_at = now() where id = p_case;
  end if;

  if v_prop is not null and p->>'approval_due_hours' is not null then
    update public.action_proposals
       set approval_due_at = coalesce(approval_due_at, v_clock + make_interval(hours => (p->>'approval_due_hours')::integer))
     where id = v_prop and scenario_run_id = p_run and status = 'aguardando_aprovacao';
  end if;

  insert into public.internal_notifications (scenario_run_id, case_id, proposal_id, kind, target_role, title, body, dedupe_key)
  values (p_run, p_case, v_prop, v_kind, nullif(p->>'target_role', '')::public.staff_role,
    coalesce(p->>'title', 'Caso encaminhado para atendimento humano'),
    coalesce(p->>'body', coalesce(p->>'decision_requested', v_reason)),
    'encaminhamento:' || coalesce(v_prop::text, 'caso') || ':' || v_reason)
  on conflict (case_id, dedupe_key) do nothing
  returning id into v_notif;

  if v_notif is not null then
    perform public.append_audit(p_run, p_case, v_prop, 'encaminhamento_humano', 'gobia', null,
      jsonb_build_object('reason', v_reason, 'team', p->>'team', 'decision_requested', p->>'decision_requested',
        'notification_id', v_notif), 'caso:' || p_case);
  end if;
  return jsonb_build_object('notification_id', v_notif, 'duplicate', v_notif is null);
end $$;

-- ---------------------------------------------------------------------------
-- Atribuição. Supervisor atribui a qualquer funcionário apto do escopo; os demais só assumem o caso para si.
-- ---------------------------------------------------------------------------
create function public.assign_case(p_case uuid, p_actor uuid, p_assignee uuid, p_note text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_actor public.staff%rowtype;
  v_to    public.staff%rowtype;
  v_case  public.cases%rowtype;
begin
  v_actor := public.assert_staff_on_case(p_actor, p_case);
  select * into v_case from public.cases where id = p_case for update;
  if v_case.status = 'resolvido' then raise exception 'estado_invalido: caso resolvido não recebe responsável'; end if;
  select * into v_to from public.staff where id = p_assignee and active;
  if not found then raise exception 'nao_encontrado: responsável inexistente ou inativo'; end if;
  if v_actor.role <> 'supervisor' and p_assignee <> p_actor then
    raise exception 'papel_insuficiente: só o supervisor atribui o caso a outra pessoa';
  end if;
  if not public.staff_has_scope(p_assignee, v_case.business_unit_id, v_case.brand_id) then
    raise exception 'fora_do_escopo: o responsável não tem escopo sobre o caso';
  end if;

  update public.cases set assigned_to = p_assignee, assignee_name = v_to.full_name, assigned_at = now(), updated_at = now()
   where id = p_case;
  perform public.append_audit(v_case.scenario_run_id, p_case, null, 'caso_atribuido', 'staff', p_actor::text,
    jsonb_build_object('assignee', p_assignee, 'assignee_name', v_to.full_name, 'previous', v_case.assigned_to,
      'by_role', v_actor.role, 'note', p_note), 'caso:' || p_case);
  if p_assignee <> p_actor then
    insert into public.internal_notifications (scenario_run_id, case_id, kind, target_staff_id, title, body, dedupe_key)
    values (v_case.scenario_run_id, p_case, 'atribuicao', p_assignee, 'Caso atribuído a você',
      coalesce(v_case.decision_requested, v_case.handoff_reason, 'Caso atribuído por ' || v_actor.full_name),
      'atribuicao:' || p_assignee || ':' || extract(epoch from clock_timestamp())::text)
    on conflict (case_id, dedupe_key) do nothing;
  end if;
  return jsonb_build_object('assigned_to', p_assignee, 'assignee_name', v_to.full_name);
end $$;

-- ---------------------------------------------------------------------------
-- Ajuste material da proposta (valor): nova versão, aprovação anterior invalidada, novo solicitante.
-- O servidor recalcula a decisão (GOB-06) e envia status, chave e decisão novos.
-- ---------------------------------------------------------------------------
create function public.adjust_proposal(p_proposal uuid, p_actor uuid, p_new_amount integer, p_new_key text,
  p_new_status text, p_decision jsonb, p_justification jsonb, p_note text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_p     public.action_proposals%rowtype;
  v_actor public.staff%rowtype;
  v_old   integer;
  v_inv   integer;
begin
  select * into v_p from public.action_proposals where id = p_proposal for update;
  if not found then raise exception 'nao_encontrado: proposta inexistente'; end if;
  v_actor := public.assert_staff_on_case(p_actor, v_p.case_id);
  if v_p.status not in ('aguardando_aprovacao','suspensa','pronta') then
    raise exception 'estado_invalido: proposta em % não pode ser ajustada', v_p.status;
  end if;
  if exists (select 1 from public.action_executions where proposal_id = p_proposal) then
    raise exception 'estado_invalido: proposta com execução iniciada não pode ser ajustada';
  end if;
  if p_new_amount is null or p_new_amount <= 0 then raise exception 'estado_invalido: valor inválido'; end if;
  if p_new_amount is not distinct from v_p.amount_cents then raise exception 'sem_mudanca: o valor não mudou'; end if;
  if p_new_status not in ('aguardando_aprovacao','pronta','bloqueada') then
    raise exception 'estado_invalido: status resultante inválido (%)', p_new_status;
  end if;
  v_old := v_p.amount_cents;

  update public.proposal_approvals
     set superseded_at = now(),
         superseded_reason = format('valor alterado de %s para %s centavos (versão %s → %s)', v_old, p_new_amount, v_p.version, v_p.version + 1)
   where proposal_id = p_proposal and decision = 'aprovada' and superseded_at is null;
  get diagnostics v_inv = row_count;

  update public.action_proposals
     set amount_cents = p_new_amount, version = version + 1, idempotency_key = p_new_key, status = p_new_status,
         decision = p_decision, justification = coalesce(p_justification, justification), requested_by = p_actor,
         escalation_level = 0, updated_at = now(),
         approval_due_at = case when p_new_status = 'aguardando_aprovacao' then approval_due_at else null end
   where id = p_proposal;

  perform public.append_audit(v_p.scenario_run_id, v_p.case_id, p_proposal, 'proposta_ajustada', 'staff', p_actor::text,
    jsonb_build_object('amount_before', v_old, 'amount_after', p_new_amount, 'version_after', v_p.version + 1,
      'status_after', p_new_status, 'approvals_invalidated', v_inv, 'by_role', v_actor.role, 'note', p_note), p_new_key);
  if v_inv > 0 then
    perform public.append_audit(v_p.scenario_run_id, v_p.case_id, p_proposal, 'aprovacao_invalidada', 'system', null,
      jsonb_build_object('reason', 'mudança material de valor', 'amount_before', v_old, 'amount_after', p_new_amount), p_new_key);
  end if;
  if p_new_status = 'aguardando_aprovacao' then
    update public.cases set status = 'aguardando_humano', decision_requested = 'Aprovar a proposta ajustada (valor e versão novos)', updated_at = now()
     where id = v_p.case_id;
    insert into public.internal_notifications (scenario_run_id, case_id, proposal_id, kind, target_role, title, body, dedupe_key)
    values (v_p.scenario_run_id, v_p.case_id, p_proposal, 'proposta_ajustada', 'supervisor', 'Proposta ajustada: nova aprovação necessária',
      format('Valor alterado de %s para %s centavos por %s. Aprovações anteriores foram invalidadas.', v_old, p_new_amount, v_actor.full_name),
      'ajuste:' || p_proposal || ':v' || (v_p.version + 1))
    on conflict (case_id, dedupe_key) do nothing;
  end if;
  return jsonb_build_object('version', v_p.version + 1, 'status', p_new_status, 'approvals_invalidated', v_inv);
end $$;

-- ---------------------------------------------------------------------------
-- Decisão humana: aprovar (registra aprovação; a liberação vem após a revalidação), rejeitar ou suspender.
-- ---------------------------------------------------------------------------
create function public.decide_proposal(p_proposal uuid, p_actor uuid, p_decision text, p_version integer,
  p_note text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_p      public.action_proposals%rowtype;
  v_actor  public.staff%rowtype;
  v_case   public.cases%rowtype;
  v_clock  timestamptz;
  v_apr    uuid;
  v_inv    integer;
  v_owner  uuid;
  v_name   text;
begin
  if p_decision not in ('aprovada','rejeitada','suspensa') then raise exception 'estado_invalido: decisão inválida'; end if;
  select * into v_p from public.action_proposals where id = p_proposal for update;
  if not found then raise exception 'nao_encontrado: proposta inexistente'; end if;
  v_actor := public.assert_staff_on_case(p_actor, v_p.case_id);
  if p_version is distinct from v_p.version then
    raise exception 'versao_desatualizada: a proposta está na versão % e a decisão se refere à versão %', v_p.version, p_version;
  end if;
  select * into v_case from public.cases where id = v_p.case_id for update;
  select clock_now into v_clock from public.scenario_runs where id = v_p.scenario_run_id;

  if p_decision = 'aprovada' then
    if v_p.status not in ('aguardando_aprovacao','suspensa') then
      raise exception 'estado_invalido: proposta em % não aguarda aprovação', v_p.status;
    end if;
    if coalesce((v_p.decision->>'approvalRequired')::boolean, false) is not true then
      raise exception 'estado_invalido: a proposta não exige aprovação';
    end if;
    if v_actor.role <> 'supervisor' then raise exception 'papel_insuficiente: só o supervisor aprova acima da alçada'; end if;
    if v_p.requested_by is not null and v_p.requested_by = p_actor then
      raise exception 'autoaprovacao: o supervisor não aprova a própria ação';
    end if;
    if v_p.amount_cents is null then raise exception 'estado_invalido: proposta sem valor não é aprovável'; end if;
    select id into v_apr from public.proposal_approvals
     where proposal_id = p_proposal and decision = 'aprovada' and superseded_at is null;
    if v_apr is not null then
      return jsonb_build_object('approval_id', v_apr, 'duplicate', true, 'version', v_p.version);
    end if;
    insert into public.proposal_approvals (scenario_run_id, proposal_id, proposal_version, order_id, action, amount_cents,
      decision, decided_by, decided_role, note, scenario_at)
    values (v_p.scenario_run_id, p_proposal, v_p.version, v_p.order_id, v_p.action, v_p.amount_cents, 'aprovada',
      p_actor, v_actor.role, p_note, v_clock)
    returning id into v_apr;
    perform public.append_audit(v_p.scenario_run_id, v_p.case_id, p_proposal, 'aprovacao_registrada', 'staff', p_actor::text,
      jsonb_build_object('approval_id', v_apr, 'version', v_p.version, 'order_id', v_p.order_id, 'action', v_p.action,
        'amount_cents', v_p.amount_cents, 'role', v_actor.role, 'note', p_note), v_p.idempotency_key);
    return jsonb_build_object('approval_id', v_apr, 'duplicate', false, 'version', v_p.version);
  end if;

  -- Rejeitar e suspender são decisões restritivas: qualquer funcionário ativo do escopo pode tomá-las.
  if v_p.status not in ('aguardando_aprovacao','suspensa','pronta','em_janela_revisao') then
    raise exception 'estado_invalido: proposta em % não pode ser %', v_p.status, p_decision;
  end if;
  if p_decision = 'suspensa' and v_p.status = 'suspensa' then
    raise exception 'estado_invalido: proposta já está suspensa';
  end if;

  update public.proposal_approvals
     set superseded_at = now(), superseded_reason = 'proposta ' || p_decision || ' por ' || v_actor.full_name
   where proposal_id = p_proposal and decision = 'aprovada' and superseded_at is null;
  get diagnostics v_inv = row_count;
  insert into public.proposal_approvals (scenario_run_id, proposal_id, proposal_version, order_id, action, amount_cents,
    decision, decided_by, decided_role, note, scenario_at)
  values (v_p.scenario_run_id, p_proposal, v_p.version, v_p.order_id, v_p.action, v_p.amount_cents, p_decision,
    p_actor, v_actor.role, p_note, v_clock);

  update public.action_proposals
     set status = case when p_decision = 'rejeitada' then 'rejeitada' else 'suspensa' end, updated_at = now()
   where id = p_proposal;

  -- Continuidade humana: quem já cuida do caso continua; senão, quem decidiu assume.
  v_owner := coalesce(v_case.assigned_to, p_actor);
  select full_name into v_name from public.staff where id = v_owner;
  update public.cases
     set status = 'aguardando_humano', assigned_to = v_owner, assignee_name = v_name,
         assigned_at = coalesce(assigned_at, now()), handoff_reason = case when p_decision = 'rejeitada' then 'proposta_rejeitada' else 'proposta_suspensa' end,
         decision_requested = case when p_decision = 'rejeitada'
           then 'Continuar o atendimento manualmente: a proposta foi rejeitada'
           else 'Proposta suspensa: decidir se retoma, ajusta ou rejeita' end,
         updated_at = now()
   where id = v_p.case_id;

  perform public.append_audit(v_p.scenario_run_id, v_p.case_id, p_proposal,
    case when p_decision = 'rejeitada' then 'proposta_rejeitada' else 'proposta_suspensa' end, 'staff', p_actor::text,
    jsonb_build_object('version', v_p.version, 'order_id', v_p.order_id, 'action', v_p.action, 'amount_cents', v_p.amount_cents,
      'role', v_actor.role, 'note', p_note, 'approvals_invalidated', v_inv, 'continuity_owner', v_owner), v_p.idempotency_key);
  insert into public.internal_notifications (scenario_run_id, case_id, proposal_id, kind, target_staff_id, title, body, dedupe_key)
  values (v_p.scenario_run_id, v_p.case_id, p_proposal,
    case when p_decision = 'rejeitada' then 'continuidade_humana' else 'proposta_suspensa' end, v_owner,
    case when p_decision = 'rejeitada' then 'Proposta rejeitada: continue o atendimento' else 'Proposta suspensa' end,
    format('%s por %s%s.', case when p_decision = 'rejeitada' then 'Rejeitada' else 'Suspensa' end, v_actor.full_name,
      coalesce(': ' || nullif(p_note, ''), '')),
    p_decision || ':' || p_proposal || ':v' || v_p.version)
  on conflict (case_id, dedupe_key) do nothing;
  return jsonb_build_object('status', case when p_decision = 'rejeitada' then 'rejeitada' else 'suspensa' end,
    'continuity_owner', v_owner, 'approvals_invalidated', v_inv);
end $$;

-- ---------------------------------------------------------------------------
-- Liberação após aprovação: exige aprovação vigente para ESTA versão, pedido, ação e valor, de supervisor que não é
-- o solicitante. p_revalidation é a decisão do GOB-06 recalculada agora com a aprovação (executable true/false).
-- ---------------------------------------------------------------------------
create function public.release_proposal(p_proposal uuid, p_revalidation jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_p public.action_proposals%rowtype;
  v_a public.proposal_approvals%rowtype;
  v_ok boolean := coalesce((p_revalidation->>'executable')::boolean, false);
begin
  select * into v_p from public.action_proposals where id = p_proposal for update;
  if not found then raise exception 'nao_encontrado: proposta inexistente'; end if;
  if v_p.status not in ('aguardando_aprovacao','suspensa') then
    raise exception 'estado_invalido: proposta em % não pode ser liberada', v_p.status;
  end if;
  select * into v_a from public.proposal_approvals
   where proposal_id = p_proposal and decision = 'aprovada' and superseded_at is null;
  if not found then raise exception 'sem_aprovacao_valida: não há aprovação vigente'; end if;
  if v_a.proposal_version <> v_p.version or v_a.amount_cents is distinct from v_p.amount_cents
     or v_a.order_id is distinct from v_p.order_id or v_a.action <> v_p.action then
    raise exception 'sem_aprovacao_valida: a aprovação não corresponde à versão, ao pedido, à ação e ao valor atuais';
  end if;
  if v_a.decided_role <> 'supervisor' or (v_p.requested_by is not null and v_p.requested_by = v_a.decided_by) then
    raise exception 'sem_aprovacao_valida: aprovador sem papel de supervisor ou igual ao solicitante';
  end if;

  if v_ok then
    update public.action_proposals set status = 'pronta', decision = p_revalidation, updated_at = now() where id = p_proposal;
    update public.cases set status = 'em_execucao', decision_requested = null, updated_at = now() where id = v_p.case_id;
    perform public.append_audit(v_p.scenario_run_id, v_p.case_id, p_proposal, 'caso_retomado', 'system', null,
      jsonb_build_object('approval_id', v_a.id, 'approved_by', v_a.decided_by, 'version', v_p.version,
        'amount_cents', v_p.amount_cents, 'revalidation', 'ok'), v_p.idempotency_key);
    return jsonb_build_object('released', true, 'approval_id', v_a.id);
  end if;

  -- A revalidação não confirmou a execução (dados mudaram desde a proposta): bloqueia e devolve a uma pessoa.
  update public.action_proposals set status = 'bloqueada', decision = p_revalidation, updated_at = now() where id = p_proposal;
  update public.cases set status = 'aguardando_humano', handoff_reason = 'revalidacao_bloqueada',
    decision_requested = 'A revalidação após a aprovação bloqueou a execução: revisar os dados do caso', updated_at = now()
   where id = v_p.case_id;
  perform public.append_audit(v_p.scenario_run_id, v_p.case_id, p_proposal, 'revalidacao_bloqueou', 'system', null,
    jsonb_build_object('approval_id', v_a.id, 'blockers', p_revalidation->'blockers'), v_p.idempotency_key);
  insert into public.internal_notifications (scenario_run_id, case_id, proposal_id, kind, target_role, title, body, dedupe_key)
  values (v_p.scenario_run_id, v_p.case_id, p_proposal, 'revalidacao_bloqueada', 'supervisor',
    'Aprovação não pôde ser executada', 'A revalidação recusou a execução: ' || coalesce(p_revalidation->>'blockers', 'dados alterados'),
    'revalidacao:' || p_proposal || ':v' || v_p.version)
  on conflict (case_id, dedupe_key) do nothing;
  return jsonb_build_object('released', false, 'approval_id', v_a.id);
end $$;

-- ---------------------------------------------------------------------------
-- Aprovação vencida: cobrança e escalonamento. NUNCA aprova. Cada nível é gerado uma única vez.
-- ---------------------------------------------------------------------------
create function public.escalate_expired_approvals(p_run uuid, p_next_hours integer default 24) returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  v_clock timestamptz;
  v_p     public.action_proposals%rowtype;
  v_n     integer := 0;
  v_lvl   integer;
begin
  select clock_now into v_clock from public.scenario_runs where id = p_run;
  for v_p in
    select * from public.action_proposals
     where scenario_run_id = p_run and status = 'aguardando_aprovacao' and approval_due_at is not null and approval_due_at <= v_clock
     for update skip locked
  loop
    v_lvl := v_p.escalation_level + 1;
    update public.action_proposals
       set escalation_level = v_lvl, approval_due_at = v_clock + make_interval(hours => p_next_hours), updated_at = now()
     where id = v_p.id;
    insert into public.internal_notifications (scenario_run_id, case_id, proposal_id, kind, target_role, title, body, dedupe_key)
    values (p_run, v_p.case_id, v_p.id, case when v_lvl = 1 then 'aprovacao_cobrada' else 'aprovacao_escalonada' end, 'supervisor',
      case when v_lvl = 1 then 'Aprovação pendente: prazo vencido' else 'Aprovação pendente escalonada' end,
      format('A proposta de %s aguarda aprovação além do prazo (nível %s). O prazo vencido não aprova: a decisão continua com o supervisor.', v_p.action, v_lvl),
      'vencida:' || v_p.id || ':n' || v_lvl)
    on conflict (case_id, dedupe_key) do nothing;
    perform public.append_audit(p_run, v_p.case_id, v_p.id, 'aprovacao_vencida', 'system', null,
      jsonb_build_object('level', v_lvl, 'due_at', v_p.approval_due_at, 'auto_approved', false), v_p.idempotency_key);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Concessões: somente service_role executa. O navegador nunca chama estas funções.
-- ---------------------------------------------------------------------------
revoke execute on function public.staff_has_scope(uuid, text, text), public.assert_staff_on_case(uuid, uuid),
  public.record_proposal(uuid, uuid, jsonb), public.create_handoff(uuid, uuid, jsonb),
  public.assign_case(uuid, uuid, uuid, text),
  public.adjust_proposal(uuid, uuid, integer, text, text, jsonb, jsonb, text),
  public.decide_proposal(uuid, uuid, text, integer, text), public.release_proposal(uuid, jsonb),
  public.escalate_expired_approvals(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.staff_has_scope(uuid, text, text), public.assert_staff_on_case(uuid, uuid),
  public.record_proposal(uuid, uuid, jsonb), public.create_handoff(uuid, uuid, jsonb),
  public.assign_case(uuid, uuid, uuid, text),
  public.adjust_proposal(uuid, uuid, integer, text, text, jsonb, jsonb, text),
  public.decide_proposal(uuid, uuid, text, integer, text), public.release_proposal(uuid, jsonb),
  public.escalate_expired_approvals(uuid, integer) to service_role;
