// GOB-09 · Candidatos a responsável: funcionários ativos com escopo sobre o caso. Leitura com a chave privilegiada,
// por isso só deve ser chamada depois de o servidor confirmar que quem pede é supervisor com acesso ao caso.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Assignable { id: string; fullName: string; role: string }

export async function listAssignableStaff(admin: SupabaseClient, c: { businessUnitId: string | null; brandId: string | null }): Promise<Assignable[]> {
  const { data, error } = await admin.from("staff").select("id, full_name, role, staff_scopes(scope, business_unit_id, brand_id)").eq("active", true).order("full_name");
  if (error) throw new Error(`equipe: ${error.message}`);
  const { data: brand } = c.brandId ? await admin.from("brands").select("business_unit_id").eq("id", c.brandId).maybeSingle() : { data: null };
  const unit = c.businessUnitId ?? (brand?.business_unit_id as string | undefined) ?? null;
  type Row = { id: string; full_name: string; role: string; staff_scopes: { scope: string; business_unit_id: string | null; brand_id: string | null }[] };
  return (data as unknown as Row[])
    .filter((s) => s.staff_scopes.some((sc) => sc.scope === "group" || (sc.scope === "unit" && !!unit && sc.business_unit_id === unit) || (sc.scope === "brand" && !!c.brandId && sc.brand_id === c.brandId)))
    .map((s) => ({ id: s.id, fullName: s.full_name, role: s.role }));
}
