// GOB-07 · Ferramentas de leitura oferecidas ao modelo, sobre as consultas da GOB-05 com o cliente da sessão (RLS aplica).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Evidence } from "../evidence.ts";
import { searchKnowledge } from "../knowledge.ts";
import { getOrderEvidence, getProductionEvidence, getProductSheet, getTrackingEvidence } from "../queries.ts";
import type { ToolName } from "./proposal.ts";

export type ToolSet = Record<ToolName, (args: Record<string, string>) => Promise<Evidence<unknown>>>;

export function dbToolSet(db: SupabaseClient, runId: string): ToolSet {
  const need = (a: Record<string, string>, k: string) => {
    if (!a[k]) throw new Error(`argumento ${k} obrigatório`);
    return a[k];
  };
  return {
    get_order: (a) => getOrderEvidence(db, runId, need(a, "order_id")),
    get_tracking: (a) => getTrackingEvidence(db, runId, need(a, "order_id")),
    get_production: (a) => getProductionEvidence(db, runId, need(a, "order_id")),
    get_product_sheet: (a) => getProductSheet(db, runId, need(a, "sku")),
    search_knowledge: (a) => searchKnowledge(db, runId, { query: a.query, category: a.category, sku: a.sku, brand: a.brand, unit: a.unit }),
  };
}
