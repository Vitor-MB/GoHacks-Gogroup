# GoBIA

Agente de atendimento da GoGroup para o desafio GoHacks Talent. O MVP tem foco em rastreio de pedidos e atrasos de entrega, com acompanhamento do cliente e revisão humana quando exigida pela política.

## Rodar localmente

Use Node.js 22 ou superior e npm. No PowerShell do Windows, rode os comandos abaixo na pasta que contém `package.json`. Em macOS ou Linux, use `npm` no lugar de `npm.cmd`.

```powershell
npm.cmd ci
npm.cmd run dev
```

Abra [http://localhost:3000](http://localhost:3000). A página inicial funciona sem configuração de serviços externos.

## Verificar o projeto

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

Após o build, `npm.cmd start` serve a versão de produção localmente.

## Configuração de ambiente

Quando as integrações forem implementadas, copie `.env.example` para `.env.local` e preencha apenas os valores do ambiente de desenvolvimento. As únicas variáveis `NEXT_PUBLIC_` previstas são a URL e a chave publicável do Supabase. A chave privilegiada, a configuração do proxy Claude e a credencial do Cron são lidas pelo módulo exclusivo de servidor em `src/server/config.ts`. Guarde os valores reais em `.env.local` ou nas configurações do ambiente de deploy.

Consulte o [planejamento](docs/PLANEJAMENTO.MD) e acompanhe o [backlog de implementação](docs/IMPLEMENTACAO.MD).
