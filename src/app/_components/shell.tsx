import Image from "next/image";
import type { ReactNode } from "react";
import logo from "../../../assets/brand/gobia-logo-v1.png";
import { signOut } from "../../server/auth/actions";
import { getCurrentStaff } from "../../server/auth/session";
import { AssistantChat } from "./assistant-chat";
import { NavLinks } from "./nav-links";

const ROLE_LABEL = { supervisor: "Supervisor", analista: "Analista", atendente: "Atendente" } as const;

/** Moldura das telas internas: barra lateral à esquerda com a navegação. Sem funcionário ativo, mostra só o conteúdo. */
export async function Shell({ children }: { children: ReactNode }) {
  const staff = await getCurrentStaff();
  if (!staff) return <>{children}</>;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Image src={logo} alt="GoBIA" sizes="140px" />
        </div>
        <NavLinks />
        <div className="sidebar-user">
          <p className="sidebar-name">{staff.fullName}</p>
          <p className="sidebar-role">{ROLE_LABEL[staff.role]}</p>
          <form action={signOut}><button type="submit">Sair</button></form>
        </div>
      </aside>
      <div className="shell-main">{children}</div>
      <AssistantChat />
    </div>
  );
}
