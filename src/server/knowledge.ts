// GOB-05 · Busca textual (PostgreSQL FTS em português) sobre políticas e fichas de produto, via RPC search_knowledge.
// Sem embeddings e sem IA. Cliente da sessão: a RLS limita o que existe; a RPC aplica vigência (relógio do cenário),
// marca/unidade/SKU e correspondência exata antes do ranking.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evidence, hitSource, knowledgeConflicts, limitContext,
  type Evidence, type KnowledgeHit,
} from "./evidence.ts";

export interface KnowledgeQuery {
  /** Texto livre do cliente/agente. Opcional quando há categoria ou SKU exatos. */
  query?: string;
  brand?: string;
  unit?: string;
  sku?: string;
  /** Chave exata da política (ex.: atraso_entrega, reacao_adversa, limites_por_papel). */
  category?: string;
  limit?: number;
  /** Orçamento total de caracteres de trechos devolvidos (contexto do modelo). */
  budgetChars?: number;
}

export interface KnowledgeResult {
  hits: KnowledgeHit[];
  omitted: number;
  chars: number;
}

type Row = {
  id: string; kind: "policy" | "product"; title: string; source: string; source_ref: string; version: string;
  valid_from: string | null; valid_to: string | null; scope: string; business_unit_id: string | null; brand_id: string | null;
  sku: string | null; category: string | null; critical: boolean; exact: boolean; all_terms: boolean; rank: number;
  snippet: string; as_of: string;
};

export async function searchKnowledge(db: SupabaseClient, runId: string, q: KnowledgeQuery): Promise<Evidence<KnowledgeResult>> {
  const { data, error } = await db.rpc("search_knowledge", {
    p_run: runId,
    p_query: q.query ?? "",
    p_brand: q.brand ?? null,
    p_unit: q.unit ?? null,
    p_sku: q.sku ?? null,
    p_category: q.category ?? null,
    p_limit: q.limit ?? 5,
    p_max_chars: 600,
  });
  if (error) throw new Error(`busca: ${error.message}`);

  const rows = data as Row[];
  const asOf = rows[0]?.as_of ?? new Date().toISOString().slice(0, 10);
  const hits: KnowledgeHit[] = rows.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, source: r.source, sourceRef: r.source_ref, version: r.version,
    validFrom: r.valid_from, validTo: r.valid_to, scope: r.scope, brandId: r.brand_id, businessUnitId: r.business_unit_id,
    sku: r.sku, category: r.category, critical: r.critical, exact: r.exact, allTerms: r.all_terms, rank: r.rank, snippet: r.snippet,
  }));

  const limited = limitContext(hits, q.budgetChars ?? 2400);
  const missing: string[] = [];
  if (hits.length === 0) {
    missing.push("nenhuma fonte vigente e autorizada encontrada; busque por campos estruturados ou peça esclarecimento");
  } else if (q.sku && !hits.some((h) => h.sku === q.sku)) {
    missing.push(`ficha do SKU ${q.sku} indisponível; não use dados de outro produto`);
  }
  if (q.category && !hits.some((h) => h.category === q.category)) missing.push(`política "${q.category}" não encontrada`);

  return evidence(asOf, { hits: limited.items, omitted: limited.omitted, chars: limited.chars }, {
    sources: limited.items.map((h) => hitSource(h, asOf)),
    missing,
    conflicts: knowledgeConflicts(limited.items, asOf),
  });
}
