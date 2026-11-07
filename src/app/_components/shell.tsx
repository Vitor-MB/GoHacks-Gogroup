import Image from "next/image";
import type { ReactNode } from "react";
import logo from "../../../assets/brand/gobia-logo-v1.png";
import { signOut } from "../../server/auth/actions";
import { getCurrentStaff } from "../../server/auth/session";
import { getAgentStatus, getSupervisionQueue, type AgentStatus } from "../../server/supervision";
import { AssistantChat } from "./assistant-chat";
import { NavLinks } from "./nav-links";

const ROLE_LABEL = { supervisor: "Supervisor", analista: "Analista", atendente: "Atendente" } as const;

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");

/** Moldura das telas internas: barra lateral, barra superior com busca e situação do agente. Sem funcionário ativo, só o conteúdo. */
export async function Shell({ children }: { children: ReactNode }) {
  const staff = await getCurrentStaff();
  if (!staff) return <>{children}</>;

  // A moldura nunca derruba a página: sem os dados, some o contador e o estado do agente fica neutro.
  let queueCount: number | null = null;
  let agent: AgentStatus | null = null;
  try {
    const [q, a] = await Promise.all([getSupervisionQueue(), getAgentStatus()]);
    queueCount = q.rows.length;
    agent = a;
  } catch {
    /* sem contador */
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Image src={logo} alt="GoBIA" sizes="120px" />
          <p>Portal do supervisor</p>
        </div>
        <NavLinks badges={queueCount === null ? {} : { "/painel": queueCount }} />
        <div className="sidebar-user">
          <span className="avatar" aria-hidden="true">{initials(staff.fullName)}</span>
          <div>
            <p className="sidebar-name">{staff.fullName}</p>
            <p className="sidebar-role">{ROLE_LABEL[staff.role]}</p>
          </div>
          <form action={signOut}><button type="submit">Sair</button></form>
        </div>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <form action="/painel" method="get" role="search" className="topbar-search">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input type="search" name="q" placeholder="Buscar por cliente, pedido ou número do processo" aria-label="Buscar na fila de supervisão" maxLength={80} />
          </form>
          {agent && (
            <p className={`agent-status agent-${agent.tone}`} role="status"><span aria-hidden="true" />{agent.label}</p>
          )}
        </header>
        {children}
      </div>
      <AssistantChat />
    </div>
  );
}
