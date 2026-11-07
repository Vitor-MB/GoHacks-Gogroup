import "server-only";
import { createSessionClient } from "../db/client";

export type StaffRole = "atendente" | "analista" | "supervisor";

export interface StaffScope {
  scope: "group" | "unit" | "brand";
  business_unit_id: string | null;
  brand_id: string | null;
}

export interface CurrentStaff {
  id: string;
  fullName: string;
  email: string;
  role: StaffRole;
  scopes: StaffScope[];
}

/**
 * Funcionário ativo da sessão atual, ou null. Valida o usuário com o Auth (getUser) e lê papel e escopo
 * das tabelas controladas pelo servidor, nunca de user_metadata. A RLS já limita a leitura ao próprio registro.
 */
export async function getCurrentStaff(): Promise<CurrentStaff | null> {
  const supabase = await createSessionClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const { data: staff } = await supabase
    .from("staff")
    .select("id, full_name, email, role, active")
    .eq("auth_user_id", auth.user.id)
    .maybeSingle();
  if (!staff || !staff.active) return null;

  const { data: scopes } = await supabase
    .from("staff_scopes")
    .select("scope, business_unit_id, brand_id")
    .eq("staff_id", staff.id);

  return {
    id: staff.id,
    fullName: staff.full_name,
    email: staff.email,
    role: staff.role as StaffRole,
    scopes: (scopes ?? []) as StaffScope[],
  };
}
