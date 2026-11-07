export const publicConfig = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

export function requirePublicConfig() {
  const { supabaseUrl, supabasePublishableKey } = publicConfig;
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      "Configuração do Supabase ausente: defina NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY em .env.local.",
    );
  }
  return { supabaseUrl, supabasePublishableKey };
}
