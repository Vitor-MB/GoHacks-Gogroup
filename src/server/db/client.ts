import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requirePublicConfig } from "../../shared/public-config";

/** Cliente com a sessão do usuário (chave publicável + RLS). Use para qualquer leitura em nome do funcionário. */
export async function createSessionClient() {
  // Ler os cookies primeiro torna a rota dinâmica: nada que dependa da sessão é pré-renderizado.
  const cookieStore = await cookies();
  const { supabaseUrl, supabasePublishableKey } = requirePublicConfig();

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(items) {
        try {
          for (const { name, value, options } of items) cookieStore.set(name, value, options);
        } catch {
          // Chamado de um Server Component: a renovação da sessão é feita pelo proxy.
        }
      },
    },
  });
}
