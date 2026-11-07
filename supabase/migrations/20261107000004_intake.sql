-- GOB-04 · Entrada de contatos: deduplicação por evento, casos com assunto e esclarecimento, associação multicanal.
-- Registros produzidos pela GoBIA carregam scenario_run_id. Escritas só pelo servidor (service_role).

-- Cliente pode ser desconhecido na chegada do contato (identidade incerta vira pendência de esclarecimento).
alter table public.conversations alter column customer_id drop not null;
alter table public.cases alter column customer_id drop not null;

-- external_id passa a ser único por cenário, para que execuções isoladas não colidam.
drop index public.conversations_channel_external_uq;
create unique index conversations_run_channel_external_uq
  on public.conversations (scenario_run_id, channel, external_id) nulls not distinct
  where external_id is not null;

alter table public.cases
  add column topic         text not null default 'outros',
  add column clarification text,
  add column sources       jsonb not null default '[]'::jsonb;

-- Mesmo cliente + mesmo pedido + mesmo assunto, ainda em aberto e já esclarecido = mesma pendência.
-- Pedido ou assunto diferente (inclui marca diferente, pois a marca vem do pedido) não se unem.
create unique index cases_open_compatible_uq
  on public.cases (scenario_run_id, customer_id, order_id, topic)
  where status <> 'resolvido' and clarification is null and customer_id is not null and order_id is not null;

-- Um registro por evento recebido; a unicidade garante entrega idempotente.
create table public.contact_events (
  id                 uuid primary key default gen_random_uuid(),
  scenario_run_id    uuid not null references public.scenario_runs (id) on delete cascade,
  channel            text not null check (channel in ('whatsapp', 'email', 'reclame_aqui')),
  external_event_id  text not null,
  conversation_id    text references public.conversations (conversation_id) on delete cascade,
  case_id            uuid references public.cases (id) on delete set null,
  received_at        timestamptz not null,
  simulated          boolean not null default true,
  result             jsonb,
  created_at         timestamptz not null default now(),
  unique (scenario_run_id, channel, external_event_id)
);
create index on public.contact_events (case_id);

alter table public.contact_events enable row level security;
create policy contact_events_scope on public.contact_events for select to authenticated
  using (exists (select 1 from public.cases k where k.id = contact_events.case_id));
grant select on public.contact_events to authenticated;

-- Grava o contato de forma atômica: evento (dedupe), conversa, mensagem e caso.
-- p_event: channel, external_event_id, external_conversation_id, source_conversation_id, text, subject, received_at
-- p_ctx:   customer_id, order_id, brand_id, business_unit_id, topic, clarification, sources
create function public.record_contact(p_run uuid, p_event jsonb, p_ctx jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_channel   text := p_event->>'channel';
  v_ext_event text := p_event->>'external_event_id';
  v_ext_conv  text := coalesce(p_event->>'external_conversation_id', p_event->>'external_event_id');
  v_received  timestamptz := (p_event->>'received_at')::timestamptz;
  v_event     uuid;
  v_conv      text;
  v_case      uuid;
  v_new_case  boolean := false;
  v_customer  text := nullif(p_ctx->>'customer_id', '');
  v_order     text := nullif(p_ctx->>'order_id', '');
  v_topic     text := coalesce(p_ctx->>'topic', 'outros');
  v_clar      text := nullif(p_ctx->>'clarification', '');
  v_result    jsonb;
begin
  if not exists (select 1 from public.scenario_runs where id = p_run) then
    raise exception 'cenário % não encontrado', p_run;
  end if;

  insert into public.contact_events (scenario_run_id, channel, external_event_id, received_at)
  values (p_run, v_channel, v_ext_event, v_received)
  on conflict (scenario_run_id, channel, external_event_id) do nothing
  returning id into v_event;

  if v_event is null then
    -- Entrega repetida: devolve o resultado já gravado, sem novos efeitos.
    select coalesce(e.result, '{}'::jsonb) || jsonb_build_object('duplicate', true) into v_result
      from public.contact_events e
     where e.scenario_run_id = p_run and e.channel = v_channel and e.external_event_id = v_ext_event;
    return v_result;
  end if;

  -- Conversa: reutiliza a de origem (fila importada) ou a do mesmo canal/identificador no cenário.
  v_conv := p_event->>'source_conversation_id';
  if v_conv is null then
    select c.conversation_id into v_conv from public.conversations c
     where c.scenario_run_id is not distinct from p_run and c.channel = v_channel and c.external_id = v_ext_conv;
    if v_conv is null then
      v_conv := 'SIM-' || upper(substr(md5(p_run::text || v_channel || v_ext_conv), 1, 10));
      insert into public.conversations (conversation_id, customer_id, order_id, brand_id, business_unit_id,
        channel, origin, external_id, opened_at, status, subject, interactions, scenario_run_id)
      values (v_conv, v_customer, v_order, nullif(p_ctx->>'brand_id', ''), nullif(p_ctx->>'business_unit_id', ''),
        v_channel, 'simulado', v_ext_conv, v_received, 'aberto', p_event->>'subject', 1, p_run);
    else
      update public.conversations set interactions = coalesce(interactions, 0) + 1 where conversation_id = v_conv;
    end if;
    insert into public.messages (message_id, conversation_id, author, sent_at, body)
    values ('SIM-' || upper(substr(md5(p_run::text || v_channel || v_ext_event), 1, 12)), v_conv, 'cliente', v_received, p_event->>'text')
    on conflict (message_id) do nothing;
  end if;

  -- Caso: conversa já vinculada > pendência compatível > novo caso.
  select cc.case_id into v_case from public.case_conversations cc
    join public.cases k on k.id = cc.case_id and k.scenario_run_id = p_run
   where cc.conversation_id = v_conv limit 1;

  if v_case is null and v_clar is null and v_customer is not null and v_order is not null then
    select k.id into v_case from public.cases k
     where k.scenario_run_id = p_run and k.customer_id = v_customer and k.order_id = v_order
       and k.topic = v_topic and k.status <> 'resolvido' and k.clarification is null
     limit 1 for update;
  end if;

  if v_case is null then
    begin
      insert into public.cases (scenario_run_id, customer_id, order_id, business_unit_id, brand_id, status,
        summary, topic, clarification, sources)
      values (p_run, v_customer, v_order, nullif(p_ctx->>'business_unit_id', ''), nullif(p_ctx->>'brand_id', ''),
        case when v_clar is null then 'novo' else 'aguardando_cliente' end,
        coalesce(nullif(p_event->>'subject', ''), left(p_event->>'text', 120)), v_topic, v_clar,
        coalesce(p_ctx->'sources', '[]'::jsonb))
      returning id into v_case;
      v_new_case := true;
    exception when unique_violation then
      -- Contato concorrente criou a mesma pendência primeiro: associa a ela.
      select k.id into v_case from public.cases k
       where k.scenario_run_id = p_run and k.customer_id = v_customer and k.order_id = v_order
         and k.topic = v_topic and k.status <> 'resolvido' and k.clarification is null;
    end;
  end if;
  if not v_new_case then
    update public.cases set updated_at = now() where id = v_case;
  end if;

  insert into public.case_conversations (case_id, conversation_id) values (v_case, v_conv)
  on conflict do nothing;

  v_result := jsonb_build_object('duplicate', false, 'case_id', v_case, 'conversation_id', v_conv,
    'new_case', v_new_case, 'needs_clarification', v_clar is not null);
  update public.contact_events set conversation_id = v_conv, case_id = v_case, result = v_result where id = v_event;
  return v_result;
end $$;

revoke execute on function public.record_contact(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_contact(uuid, jsonb, jsonb) to service_role;

-- Reset passa a limpar também os eventos de contato (casos e conversas do cenário já eram removidos).
create or replace function public.reset_scenario_run(p_run uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.scenario_runs where id = p_run) then
    raise exception 'cenário % não encontrado', p_run;
  end if;
  delete from public.contact_events where scenario_run_id = p_run;
  delete from public.cases where scenario_run_id = p_run;
  delete from public.conversations where scenario_run_id = p_run;
  update public.scenario_runs set clock_now = clock_start where id = p_run;
end $$;
