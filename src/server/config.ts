import "server-only";

export function readServerConfig() {
  return {
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
    claudeProxyUrl: process.env.CLAUDE_PROXY_URL,
    claudeProxyToken: process.env.CLAUDE_PROXY_TOKEN,
    claudeModel: process.env.CLAUDE_MODEL,
    cronSecret: process.env.CRON_SECRET,
  };
}
