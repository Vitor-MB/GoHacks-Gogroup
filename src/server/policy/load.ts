// GOB-09 · Parâmetros da política vigente lidos do banco (importados de BD/politicas.csv). Nunca vêm do modelo.
import type { SupabaseClient } from "@supabase/supabase-js";
import { paramsFromPolicy, type PolicyParams } from "./decision.ts";

export async function loadPolicyParams(db: SupabaseClient): Promise<PolicyParams> {
  const { data, error } = await db.from("policies").select("section, rule, value");
  if (error) throw new Error(`política: ${error.message}`);
  return paramsFromPolicy((data ?? []).map((r) => ({ secao: r.section as string, regra: r.rule as string, valor: (r.value as string | null) ?? "" })));
}
