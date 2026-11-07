"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/painel", label: "Fila de supervisão", icon: "M3 3h8v10H3zM13 3h8v6h-8zM13 11h8v10h-8zM3 15h8v6H3z", active: (p: string) => p === "/painel" },
  { href: "/fila", label: "Todos os casos", icon: "M4 6h16M4 12h16M4 18h10", active: (p: string) => p === "/fila" || (p.startsWith("/fila/") && !p.startsWith("/fila/pendencias")) },
  { href: "/resolvidos", label: "Atendimentos resolvidos", icon: "M20 6 9 17l-5-5", active: (p: string) => p.startsWith("/resolvidos") },
  { href: "/estatisticas", label: "Estatísticas", icon: "M4 20V10M10 20V4M16 20v-8M22 20H2", active: (p: string) => p.startsWith("/estatisticas") },
  { href: "/simulador", label: "Simulador de chat", icon: "M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.6A8 8 0 1 1 21 12z", active: (p: string) => p.startsWith("/simulador") },
  { href: "/fila/pendencias", label: "Auditoria", icon: "M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6zM9 12l2 2 4-4", active: (p: string) => p.startsWith("/fila/pendencias") },
];

export function NavLinks({ badges = {} }: { badges?: Record<string, number> }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Principal" className="nav">
      {ITEMS.map((i) => {
        const on = i.active(pathname);
        const n = badges[i.href];
        return (
          <Link key={i.href} href={i.href} className={on ? "nav-link is-active" : "nav-link"} aria-current={on ? "page" : undefined}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={i.icon} /></svg>
            <span>{i.label}</span>
            {n !== undefined && n > 0 && <span className="nav-badge" aria-label={`${n} aguardando`}>{n}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
