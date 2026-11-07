-- GOB-02 · Verificação de RLS com dados temporários. Tudo termina em ROLLBACK.
-- Pré-requisito: migrations e seed.sql aplicados, com os 3 usuários de teste criados no Auth.
-- Esperado: operador vê 2 pedidos; restrito vê 1 (Kokeshi); anon recebe erro de permissão.

begin;

insert into public.customers (customer_id) values ('CHTEST01');
insert into public.products (sku, name, brand_id, business_unit_id) values
  ('TST-GOC', 'Produto teste Gocase', 'gocase', 'gocase'),
  ('TST-KOK', 'Produto teste Kokeshi', 'kokeshi', 'gobeaute');
insert into public.orders (order_id, customer_id, brand_id, business_unit_id, ordered_at, total_cents, sku) values
  ('GCHTEST1', 'CHTEST01', 'gocase',  'gocase',   now(), 10000, 'TST-GOC'),
  ('GBHTEST1', 'CHTEST01', 'kokeshi', 'gobeaute', now(), 5000,  'TST-KOK');

-- 1) Operador com escopo de grupo
select set_config('request.jwt.claims',
  json_build_object('sub', (select auth_user_id from public.staff where email = 'operador@gobia.test'), 'role', 'authenticated')::text, true);
set local role authenticated;
select 'operador' as quem, count(*) as pedidos_visiveis from public.orders where order_id in ('GCHTEST1', 'GBHTEST1');
reset role;

-- 2) Restrito à marca Kokeshi
select set_config('request.jwt.claims',
  json_build_object('sub', (select auth_user_id from public.staff where email = 'restrito@gobia.test'), 'role', 'authenticated')::text, true);
set local role authenticated;
select 'restrito' as quem, count(*) as pedidos_visiveis from public.orders where order_id in ('GCHTEST1', 'GBHTEST1');
select 'restrito_cliente' as quem, count(*) as clientes_visiveis from public.customers where customer_id = 'CHTEST01';
-- CPF deve falhar por falta de permissão de coluna:
-- select cpf from public.customers;   -- descomente para testar (erro esperado)
reset role;

-- 3) Sem sessão (anon): deve dar "permission denied"
set local role anon;
select count(*) from public.orders;   -- erro esperado
rollback;
