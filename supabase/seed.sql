-- Seed de DESENVOLVIMENTO (GOB-02). Não aplicar em produção: unidades e marcas reais vêm do catálogo na GOB-03.
-- Antes de rodar, crie 3 usuários em Authentication > Users (e-mail confirmado):
--   operador@gobia.test, supervisor@gobia.test, restrito@gobia.test
-- Pode ser reexecutado: o vínculo com auth.users é atualizado.

insert into public.business_units (id, name) values
  ('gocase', 'Gocase'), ('gobeaute', 'GoBeauté')
on conflict (id) do nothing;

insert into public.brands (id, name, business_unit_id) values
  ('gocase', 'Gocase', 'gocase'),
  ('apice', 'Ápice', 'gobeaute'), ('barbours', 'Barbour''s', 'gobeaute'), ('kokeshi', 'Kokeshi', 'gobeaute'),
  ('rituaria', 'Rituária', 'gobeaute'), ('lescent', 'Lescent', 'gobeaute'), ('by-samia', 'By Samia', 'gobeaute'),
  ('aua', 'Auá', 'gobeaute'), ('yenzah', 'Yenzah', 'gobeaute')
on conflict (id) do nothing;

insert into public.staff (staff_code, auth_user_id, full_name, email, role)
select v.code, (select u.id from auth.users u where u.email = v.email), v.name, v.email, v.role::public.staff_role
from (values
  ('dev_operador',   'operador@gobia.test',   'Operador Teste',   'atendente'),
  ('dev_supervisor', 'supervisor@gobia.test', 'Supervisor Teste', 'supervisor'),
  ('dev_restrito',   'restrito@gobia.test',   'Restrito Teste',   'atendente')
) as v(code, email, name, role)
on conflict (email) do update set auth_user_id = excluded.auth_user_id;

insert into public.staff_scopes (staff_id, scope, business_unit_id, brand_id)
select s.id, x.scope::public.scope_type, x.unit, x.brand
from public.staff s
join (values
  ('operador@gobia.test',   'group', null, null),
  ('supervisor@gobia.test', 'group', null, null),
  ('restrito@gobia.test',   'brand', null, 'kokeshi')
) as x(email, scope, unit, brand) on x.email = s.email
on conflict do nothing;
