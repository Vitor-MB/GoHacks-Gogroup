-- GOB-11 · Eventos de desempenho, encerramento válido, pesquisa de satisfação (CSAT) e uso de IA.
-- Escritas só pelo servidor (service_role, via RPC ou inserção direta). O navegador lê pela RLS herdada do caso.
-- Tempos de eventos do MVP usam o RELÓGIO DO CENÁRIO (scenario_runs.clock_now); o histórico importado usa as datas do CSV.
-- Nada aqui altera política, alçada, timer ou modelo: a pesquisa só gera revisão humana e candidatos à avaliação.

-- ---------------------------------------------------------------------------
-- Pesquisas do histórico importado (BD/avaliacoes_csat.csv): enviadas e respondidas, para a taxa de resposta real.
-- ---------------------------------------------------------------------------
create table public.survey_history (
  survey_id        text primary key,
  conversation_id  text not null,
  channel          text not null check (channel in ('whatsapp', 'email', 'reclame_aqui')),
  brand_id         text references public.brands (id),
  business_unit_id text references public.business_units (id),
  sent_at          timestamptz not null,
  answered_at      timestamptz,
  score            smallint check (score between 1 and 5),
  comment          text,
  check ((answered_at is null) = (score is null))
);
create index on public.survey_history (conversation_id);
alter table public.survey_history enable row level security;
create policy survey_history_scope on public.survey_history for select to authenticated
  using (private.can_access(business_unit_id, brand_id));
grant select on public.survey_history to authenticated;

-- ---------------------------------------------------------------------------
-- Eventos de desempenho do MVP (acrescentados; o fluxo comum não os reescreve).
-- ---------------------------------------------------------------------------
create table public.case_events (
  id              bigint generated always as identity primary key,
  scenario_run_id uuid not null references public.scenario_runs (id) on delete cascade,
  case_id         uuid not null references public.cases (id) on delete cascade,
  event_type      text not null check (event_type in ('caso_aberto','status_alterado','primeira_resposta','intervencao_humana',
                    'resolvido','reaberto','pesquisa_solicitada','pesquisa_respondida')),
  occurred_at     timestamptz not null,      -- relógio do cenário
  actor_type      text not null default 'system' check (actor_type in ('gobia','staff','system','adapter','cliente')),
  actor_id        text,
  simulated       boolean not null default true,
  data            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index on public.case_events (case_id, id);
create index on public.case_events (scenario_run_id, event_type);
-- Só a primeira resposta substantiva conta; saudação automática nunca vira este evento.
create unique index case_events_first_response_uq on public.case_events (case_id) where event_type = 'primeira_resposta';

create function public.case_events_block_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'case_events é somente de acréscimo';
end $$;
create trigger case_events_no_update before update on public.case_events
  for each row execute function public.case_events_block_update();

alter table public.case_events enable row level security;
create policy case_events_scope on public.case_events for select to authenticated
  using (exists (select 1 from public.cases k where k.id = case_events.case_id));
grant select on public.case_events to authenticated;

-- Relógio do cenário em um só lugar.
create function public.scenario_now(p_run uuid) returns timestamptz
language sql stable security invoker set search_path = '' as $$
  select r.clock_now from public.scenario_runs r where r.id = p_run
$$;

-- Caso aberto e mudanças de estado (base do tempo de espera).
create function public.cases_events_trg() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.case_events (scenario_run_id, case_id, event_type, occurred_at, data)
    values (new.scenario_run_id, new.id, 'caso_aberto', public.scenario_now(new.scenario_run_id),
            jsonb_build_object('topic', new.topic, 'status', new.status));
  elsif new.status is distinct from old.status then
    insert into public.case_events (scenario_run_id, case_id, event_type, occurred_at, data)
    values (new.scenario_run_id, new.id, 'status_alterado', public.scenario_now(new.scenario_run_id),
            jsonb_build_object('de', old.status, 'para', new.status));
  end if;
  return new;
end $$;
create trigger cases_events_ins after insert on public.cases for each row execute function public.cases_events_trg();
create trigger cases_events_upd after update of status on public.cases for each row execute function public.cases_events_trg();

-- Primeira resposta substantiva = primeira notificação ao cliente baseada em resultado confirmado (outbox).
-- A pesquisa de satisfação e os avisos internos não contam.
create function public.outbox_first_response_trg() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.kind = 'notificacao_cliente' then
    insert into public.case_events (scenario_run_id, case_id, event_type, occurred_at, actor_type, data)
    values (new.scenario_run_id, new.case_id, 'primeira_resposta', public.scenario_now(new.scenario_run_id), 'gobia',
            jsonb_build_object('substantiva', true, 'outbox_id', new.id))
    on conflict (case_id) where event_type = 'primeira_resposta' do nothing;
  end if;
  return new;
end $$;

-- Intervenção humana identificada: ação de funcionário ou encaminhamento para pessoa.
create function public.audit_intervention_trg() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.case_id is not null and (new.actor_type = 'staff' or new.event_type = 'encaminhamento_humano') then
    insert into public.case_events (scenario_run_id, case_id, event_type, occurred_at, actor_type, actor_id, data)
    values (new.scenario_run_id, new.case_id, 'intervencao_humana', coalesce(new.scenario_at, public.scenario_now(new.scenario_run_id)),
            new.actor_type, new.actor_id, jsonb_build_object('motivo', new.event_type, 'proposal_id', new.proposal_id));
  end if;
  return new;
end $$;
create trigger audit_intervention after insert on public.audit_events for each row execute function public.audit_intervention_trg();

-- Aviso da pesquisa passa a ser um tipo de outbox; aviso interno de pesquisa negativa idem.
alter table public.outbox_events drop constraint outbox_events_kind_check;
alter table public.outbox_events add constraint outbox_events_kind_check
  check (kind in ('notificacao_cliente','intervencao_humana','pesquisa_satisfacao'));
create trigger outbox_first_response after insert on public.outbox_events for each row execute function public.outbox_first_response_trg();

alter table public.internal_notifications drop constraint internal_notifications_kind_check;
alter table public.internal_notifications add constraint internal_notifications_kind_check
  check (kind in ('encaminhamento','aprovacao_solicitada','aprovacao_cobrada','aprovacao_escalonada','atribuicao',
    'continuidade_humana','proposta_suspensa','proposta_ajustada','revalidacao_bloqueada','pesquisa_negativa'));

-- ---------------------------------------------------------------------------
-- Encerramento válido, pesquisa e revisão
-- ---------------------------------------------------------------------------
create table public.case_closures (
  id                   uuid primary key default gen_random_uuid(),
  scenario_run_id      uuid not null references public.scenario_runs (id) on delete cascade,
  case_id              uuid not null references public.cases (id) on delete cascade,
  seq                  integer not null,                 -- 1º encerramento, 2º (após reabertura), ...
  closed_at            timestamptz not null,             -- relógio do cenário
  resolution_mode      text not null check (resolution_mode in ('autonoma','assistida')),
  closed_by            uuid references public.staff (id) on delete set null,
  channel              text not null check (channel in ('whatsapp','email','reclame_aqui')),
  intervention_reasons jsonb not null default '[]'::jsonb,
  versions             jsonb not null default '{}'::jsonb, -- versões de política e modelo vigentes no encerramento
  reopened_at          timestamptz,
  created_at           timestamptz not null default now(),
  unique (case_id, seq)
);
create index on public.case_closures (scenario_run_id);

create table public.case_surveys (
  id              uuid primary key default gen_random_uuid(),
  scenario_run_id uuid not null references public.scenario_runs (id) on delete cascade,
  case_id         uuid not null references public.cases (id) on delete cascade,
  closure_id      uuid not null unique references public.case_closures (id) on delete cascade, -- uma pesquisa por encerramento
  channel         text not null check (channel in ('whatsapp','email','reclame_aqui')),
  status          text not null default 'solicitada' check (status in ('solicitada','respondida')),
  requested_at    timestamptz not null,
  answered_at     timestamptz,
  score           smallint check (score between 1 and 5),
  resolved        text check (resolved in ('sim','parcialmente','nao')),
  comment         text,
  simulated       boolean not null default true,
  created_at      timestamptz not null default now(),
  check (status = 'solicitada' or (score is not null and resolved is not null and answered_at is not null))
);
create index on public.case_surveys (scenario_run_id);

create table public.survey_reviews (
  id               uuid primary key default gen_random_uuid(),
  scenario_run_id  uuid not null references public.scenario_runs (id) on delete cascade,
  case_id          uuid not null references public.cases (id) on delete cascade,
  survey_id        uuid not null unique references public.case_surveys (id) on delete cascade,
  reason           text not null,
  status           text not null default 'pendente' check (status in ('pendente','concluida')),
  improvement_area text check (improvement_area in ('prompt','conhecimento','roteamento','politica','outro')),
  eval_set         boolean not null default false,  -- candidato ao conjunto fixo de avaliação de versões futuras
  note             text,
  reviewed_by      uuid references public.staff (id) on delete set null,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index on public.survey_reviews (scenario_run_id, status);

alter table public.case_closures  enable row level security;
alter table public.case_surveys   enable row level security;
alter table public.survey_reviews enable row level security;
grant select on public.case_closures, public.case_surveys, public.survey_reviews to authenticated;
create policy closures_scope on public.case_closures for select to authenticated
  using (exists (select 1 from public.cases k where k.id = case_closures.case_id));
create policy surveys_scope on public.case_surveys for select to authenticated
  using (exists (select 1 from public.cases k where k.id = case_surveys.case_id));
create policy reviews_scope on public.survey_reviews for select to authenticated
  using (exists (select 1 from public.cases k where k.id = survey_reviews.case_id));

-- ---------------------------------------------------------------------------
-- Uso de IA por chamada. Custo, tokens e latência são NULOS quando o provedor não informa (nunca zero).
-- ---------------------------------------------------------------------------
create table public.ai_usage (
  id                bigint generated always as identity primary key,
  scenario_run_id   uuid not null references public.scenario_runs (id) on delete cascade,
  case_id           uuid references public.cases (id) on delete cascade,
  step              text not null,
  adapter_kind      text not null check (adapter_kind in ('proxy','simulado')),
  requested_model   text,
  served_model      text,
  prompt_tokens     integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  cost_usd          numeric check (cost_usd is null or cost_usd >= 0),
  latency_ms        integer check (latency_ms is null or latency_ms >= 0),
  ok                boolean not null default true,
  error_kind        text,
  attempt           integer not null default 1,
  occurred_at       timestamptz not null,
  created_at        timestamptz not null default now()
);
create index on public.ai_usage (scenario_run_id, case_id);
alter table public.ai_usage enable row level security;
grant select on public.ai_usage to authenticated;
create policy ai_usage_scope on public.ai_usage for select to authenticated
  using (case_id is not null and exists (select 1 from public.cases k where k.id = ai_usage.case_id));

-- ---------------------------------------------------------------------------
-- Encerrar caso (válido) e solicitar UMA pesquisa por encerramento.
-- Idempotente: caso já resolvido devolve o encerramento vigente, sem nova pesquisa (nem por outro canal).
-- ---------------------------------------------------------------------------
create function public.close_case(p_case uuid, p_actor uuid default null, p_note text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_case     public.cases%rowtype;
  v_clock    timestamptz;
  v_closure  public.case_closures%rowtype;
  v_survey   public.case_surveys%rowtype;
  v_channel  text;
  v_reasons  jsonb;
  v_mode     text;
  v_versions jsonb;
  v_seq      integer;
begin
  select * into v_case from public.cases where id = p_case for update;
  if not found then raise exception 'caso % não encontrado', p_case; end if;
  if p_actor is not null then perform public.assert_staff_on_case(p_actor, p_case); end if;

  if v_case.status = 'resolvido' then
    select * into v_closure from public.case_closures where case_id = p_case order by seq desc limit 1;
    select * into v_survey from public.case_surveys where closure_id = v_closure.id;
    return jsonb_build_object('closure_id', v_closure.id, 'survey_id', v_survey.id, 'seq', v_closure.seq,
      'resolution_mode', v_closure.resolution_mode, 'already_closed', true, 'survey_requested', false);
  end if;

  -- Encerramento válido: nada pendente de decisão, execução ou correção.
  if exists (select 1 from public.action_proposals
              where case_id = p_case
                and status in ('proposta','aguardando_aprovacao','em_janela_revisao','pronta','executando','suspensa','falhou','bloqueada')) then
    raise exception 'estado_invalido: há proposta pendente de decisão, execução ou correção';
  end if;
  if v_case.clarification is not null then
    raise exception 'estado_invalido: caso com esclarecimento pendente';
  end if;

  v_clock := public.scenario_now(v_case.scenario_run_id);

  select coalesce(jsonb_agg(distinct x.motivo), '[]'::jsonb) into v_reasons from (
    select e.data->>'motivo' as motivo from public.case_events e where e.case_id = p_case and e.event_type = 'intervencao_humana'
    union select 'responsavel_atribuido' where v_case.assigned_to is not null
    union select 'encaminhamento:' || v_case.handoff_reason where v_case.handoff_reason is not null
    union select 'aprovacao_humana' where exists (select 1 from public.proposal_approvals a
             join public.action_proposals p on p.id = a.proposal_id where p.case_id = p_case)
    union select 'encerrado_por_pessoa' where p_actor is not null
  ) x where x.motivo is not null;
  v_mode := case when jsonb_array_length(v_reasons) > 0 then 'assistida' else 'autonoma' end;

  -- Canal da pesquisa: UM só, o da conversa privada mais recente (WhatsApp/e-mail); só Reclame Aqui = esse canal, via privado.
  select c.channel into v_channel
    from public.case_conversations cc join public.conversations c on c.conversation_id = cc.conversation_id
   where cc.case_id = p_case
   order by (c.channel <> 'reclame_aqui') desc, c.opened_at desc limit 1;
  v_channel := coalesce(v_channel, 'email');

  select jsonb_build_object(
           'policy_versions', coalesce((select jsonb_agg(distinct p.policy_version) from public.action_proposals p
                                         where p.case_id = p_case and p.policy_version is not null), '[]'::jsonb),
           'proposed_by', coalesce((select jsonb_agg(distinct p.proposed_by) from public.action_proposals p
                                     where p.case_id = p_case), '[]'::jsonb))
    into v_versions;

  select coalesce(max(seq), 0) + 1 into v_seq from public.case_closures where case_id = p_case;
  insert into public.case_closures (scenario_run_id, case_id, seq, closed_at, resolution_mode, closed_by, channel,
                                    intervention_reasons, versions)
  values (v_case.scenario_run_id, p_case, v_seq, v_clock, v_mode, p_actor, v_channel, v_reasons, v_versions)
  returning * into v_closure;

  update public.cases set status = 'resolvido', updated_at = now() where id = p_case;

  insert into public.case_surveys (scenario_run_id, case_id, closure_id, channel, requested_at)
  values (v_case.scenario_run_id, p_case, v_closure.id, v_channel, v_clock)
  on conflict (closure_id) do nothing
  returning * into v_survey;

  insert into public.case_events (scenario_run_id, case_id, event_type, occurred_at, actor_type, actor_id, data)
  values (v_case.scenario_run_id, p_case, 'resolvido', v_clock, case when p_actor is null then 'gobia' else 'staff' end,
          p_actor::text, jsonb_build_object('closure_id', v_closure.id, 'seq', v_seq, 'modo', v_mode)),
         (v_case.scenario_run_id, p_case, 'pesquisa_solicitada', v_clock, 'system', null,
          jsonb_build_object('survey_id', v_survey.id, 'canal', v_channel));

  insert into public.outbox_events (scenario_run_id, case_id, kind, payload)
  values (v_case.scenario_run_id, p_case, 'pesquisa_satisfacao',
          jsonb_build_object('survey_id', v_survey.id, 'channel', v_channel, 'closure_id', v_closure.id,
            'private_only', true,  -- nunca publicar a pesquisa no Reclame Aqui
            'questions', jsonb_build_array('nota_1_a_5', 'problema_resolvido_sim_parcialmente_nao', 'comentario_opcional')));

  perform public.append_audit(v_case.scenario_run_id, p_case, null, 'caso_resolvido',
    case when p_actor is null then 'gobia' else 'staff' end, p_actor::text,
    jsonb_build_object('closure_id', v_closure.id, 'seq', v_seq, 'modo', v_mode, 'motivos', v_reasons, 'nota', p_note,
                       'survey_id', v_survey.id, 'canal_pesquisa', v_channel, 'versions', v_versions));

  return jsonb_build_object('closure_id', v_closure.id, 'survey_id', v_survey.id, 'seq', v_seq,
    'resolution_mode', v_mode, 'already_closed', false, 'survey_requested', true, 'channel', v_channel);
end $$;

-- ---------------------------------------------------------------------------
-- Resposta da pesquisa. Só a primeira resposta vale (repetição devolve a registrada).
-- "não" ou "parcialmente": reabre o caso, encaminha a uma pessoa e cria revisão. Nota baixa sozinha não faz isso.
-- ---------------------------------------------------------------------------
create function public.record_survey_response(p_survey uuid, p_score integer, p_resolved text, p_comment text default null)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_s       public.case_surveys%rowtype;
  v_case    public.cases%rowtype;
  v_clock   timestamptz;
  v_review  uuid;
  v_latest  integer;
  v_closure public.case_closures%rowtype;
  v_reopened boolean := false;
begin
  if p_score is null or p_score not between 1 and 5 then raise exception 'nota inválida: informe de 1 a 5'; end if;
  if p_resolved is null or p_resolved not in ('sim','parcialmente','nao') then
    raise exception 'resolução inválida: use sim, parcialmente ou nao';
  end if;

  select * into v_s from public.case_surveys where id = p_survey for update;
  if not found then raise exception 'pesquisa % não encontrada', p_survey; end if;
  if v_s.status = 'respondida' then
    return jsonb_build_object('survey_id', v_s.id, 'reused', true, 'score', v_s.score, 'resolved', v_s.resolved);
  end if;

  v_clock := public.scenario_now(v_s.scenario_run_id);
  update public.case_surveys set status = 'respondida', answered_at = v_clock, score = p_score, resolved = p_resolved,
         comment = nullif(btrim(p_comment), '') where id = v_s.id;

  insert into public.case_events (scenario_run_id, case_id, event_type, occurred_at, actor_type, data)
  values (v_s.scenario_run_id, v_s.case_id, 'pesquisa_respondida', v_clock, 'cliente',
          jsonb_build_object('survey_id', v_s.id, 'nota', p_score, 'resolvido', p_resolved));
  perform public.append_audit(v_s.scenario_run_id, v_s.case_id, null, 'pesquisa_respondida', 'system', null,
    jsonb_build_object('survey_id', v_s.id, 'nota', p_score, 'resolvido', p_resolved));

  if p_resolved in ('nao', 'parcialmente') then
    select * into v_case from public.cases where id = v_s.case_id for update;
    select * into v_closure from public.case_closures where id = v_s.closure_id;
    select max(seq) into v_latest from public.case_closures where case_id = v_s.case_id;

    insert into public.survey_reviews (scenario_run_id, case_id, survey_id, reason)
    values (v_s.scenario_run_id, v_s.case_id, v_s.id,
            case p_resolved when 'nao' then 'Cliente informou que o problema NÃO foi resolvido.'
                            else 'Cliente informou que o problema foi resolvido PARCIALMENTE.' end)
    on conflict (survey_id) do nothing
    returning id into v_review;

    -- Só reabre se este é o encerramento vigente (não reabre um caso já tratado depois).
    if v_review is not null and v_closure.seq = v_latest and v_case.status = 'resolvido' then
      begin
        update public.cases set status = 'aguardando_humano', handoff_reason = 'pesquisa_negativa',
               handoff_team = 'atendimento', updated_at = now(),
               decision_requested = case p_resolved when 'nao' then 'Cliente diz que não foi resolvido: retomar o atendimento.'
                                    else 'Cliente diz que foi resolvido só em parte: complementar o atendimento.' end
         where id = v_s.case_id;
        v_reopened := true;
      exception when unique_violation then
        -- Já existe outro caso aberto compatível (mesmo cliente, pedido e assunto): a revisão fica, o caso não é duplicado.
        v_reopened := false;
      end;
    end if;
    if v_reopened then
      update public.case_closures set reopened_at = v_clock where id = v_closure.id;
      insert into public.case_events (scenario_run_id, case_id, event_type, occurred_at, actor_type, data)
      values (v_s.scenario_run_id, v_s.case_id, 'reaberto', v_clock, 'cliente',
              jsonb_build_object('origem', 'pesquisa', 'closure_id', v_closure.id, 'survey_id', v_s.id));
      insert into public.internal_notifications (scenario_run_id, case_id, kind, target_role, title, body, dedupe_key)
      values (v_s.scenario_run_id, v_s.case_id, 'pesquisa_negativa', 'supervisor',
              'Pesquisa negativa: revisar e dar continuidade',
              'Resposta "' || p_resolved || '" na pesquisa de satisfação. O caso voltou à fila humana.',
              'pesquisa:' || v_s.id::text)
      on conflict (case_id, dedupe_key) do nothing;
      perform public.append_audit(v_s.scenario_run_id, v_s.case_id, null, 'pesquisa_negativa_revisao', 'system', null,
        jsonb_build_object('survey_id', v_s.id, 'review_id', v_review, 'resolvido', p_resolved, 'reaberto', true));
    end if;
  end if;

  return jsonb_build_object('survey_id', v_s.id, 'reused', false, 'score', p_score, 'resolved', p_resolved,
    'review_id', v_review, 'reopened', v_reopened);
end $$;

-- Conclusão da revisão por supervisor/analista; marcar candidato ao conjunto fixo de avaliação. Não muda nada automaticamente.
create function public.complete_survey_review(p_review uuid, p_actor uuid, p_note text, p_area text, p_eval_set boolean)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_r     public.survey_reviews%rowtype;
  v_staff public.staff%rowtype;
begin
  select * into v_r from public.survey_reviews where id = p_review for update;
  if not found then raise exception 'revisão % não encontrada', p_review; end if;
  v_staff := public.assert_staff_on_case(p_actor, v_r.case_id);
  if v_staff.role not in ('supervisor', 'analista') then raise exception 'papel_insuficiente: revisão exige supervisor ou analista'; end if;
  if p_area is not null and p_area not in ('prompt','conhecimento','roteamento','politica','outro') then
    raise exception 'área inválida: %', p_area;
  end if;
  update public.survey_reviews set status = 'concluida', improvement_area = p_area, eval_set = coalesce(p_eval_set, false),
         note = nullif(btrim(p_note), ''), reviewed_by = p_actor, reviewed_at = public.scenario_now(v_r.scenario_run_id)
   where id = p_review;
  perform public.append_audit(v_r.scenario_run_id, v_r.case_id, null, 'revisao_pesquisa_concluida', 'staff', p_actor::text,
    jsonb_build_object('review_id', p_review, 'area', p_area, 'eval_set', coalesce(p_eval_set, false)));
  return jsonb_build_object('review_id', p_review, 'status', 'concluida', 'eval_set', coalesce(p_eval_set, false));
end $$;

revoke execute on function public.close_case(uuid, uuid, text), public.record_survey_response(uuid, integer, text, text),
  public.complete_survey_review(uuid, uuid, text, text, boolean), public.scenario_now(uuid)
  from public, anon, authenticated;
grant execute on function public.close_case(uuid, uuid, text), public.record_survey_response(uuid, integer, text, text),
  public.complete_survey_review(uuid, uuid, text, text, boolean), public.scenario_now(uuid) to service_role;

-- Reset do cenário também limpa o uso de IA sem caso associado (o resto sai em cascata com os casos).
create or replace function public.reset_scenario_run(p_run uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.scenario_runs where id = p_run) then
    raise exception 'cenário % não encontrado', p_run;
  end if;
  delete from public.ai_usage where scenario_run_id = p_run;
  delete from public.simulated_operations where scenario_run_id = p_run;
  delete from public.carrier_tickets where scenario_run_id = p_run;
  delete from public.contact_events where scenario_run_id = p_run;
  delete from public.cases where scenario_run_id = p_run;
  delete from public.conversations where scenario_run_id = p_run;
  update public.scenario_runs set clock_now = clock_start where id = p_run;
end $$;
