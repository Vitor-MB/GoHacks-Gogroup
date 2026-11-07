import "server-only";
import { createClient } from "@supabase/supabase-js";
import { requirePublicConfig } from "../../shared/public-config";
import { readServerConfig } from "../config";

/**
 * Cliente privilegiado (ignora RLS). Restrito à importação e ao processamento interno:
 * quem chama deve validar papel e escopo explicitamente. Nunca usar em resposta direta a uma ação do usuário
 * sem essa validação.
 */
export function createAdminClient() {
  const { supabaseUrl } = requirePublicConfig();
  const { supabaseSecretKey } = readServerConfig();
  if (!supabaseSecretKey) throw new Error("SUPABASE_SECRET_KEY ausente no ambiente do servidor.");

  return createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
