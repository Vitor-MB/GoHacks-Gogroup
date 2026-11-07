-- GOB-10 · Configuração do Supabase Cron para o processador de tarefas. NÃO é uma migration e NÃO foi ativada.
-- A ativação e a verificação no ambiente publicado são da GOB-14.
--
-- O que faz: uma chamada por minuto a POST /api/internal/jobs/process, com o segredo dedicado (CRON_SECRET) no cabeçalho.
-- A rota reserva um lote curto de tarefas vencidas, revalida e executa; invocações repetidas ou simultâneas não duplicam o efeito.
--
-- Antes de ativar (somente no projeto de PRODUÇÃO; previews e desenvolvimento usam outro banco e nunca apontam para cá):
--   1. Habilitar as extensões pg_cron e pg_net (Dashboard > Database > Extensions).
--   2. Guardar a URL estável de produção e o segredo no Vault, sem escrevê-los neste arquivo nem no Git:
--        select vault.create_secret('https://SEU-DOMINIO-DE-PRODUCAO', 'gobia_app_url');
--        select vault.create_secret('<mesmo valor do CRON_SECRET na Vercel>', 'gobia_cron_secret');
--   3. Se a proteção de deploy da Vercel estiver ativa, liberar o agendador (bypass de automação) para essa rota.
--   4. Conferir a cota de invocações e a frequência (1/min) contra o plano da Vercel e do Supabase.
--
-- Ativar:
select cron.schedule(
  'gobia-process-jobs',
  '* * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'gobia_app_url') || '/api/internal/jobs/process',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'gobia_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- Verificar execuções e respostas:
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select id, status_code, left(content, 200) from net._http_response order by created desc limit 10;
-- Desativar:
--   select cron.unschedule('gobia-process-jobs');
