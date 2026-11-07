import "server-only";

export function readServerConfig() {
  return {
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
    claudeProxyUrl: process.env.CLAUDE_PROXY_URL,
    claudeProxyToken: process.env.CLAUDE_PROXY_TOKEN,
    claudeModel: process.env.CLAUDE_MODEL,
    claudeModelEconomy: process.env.CLAUDE_MODEL_ECONOMY,
    claudeModelReasoning: process.env.CLAUDE_MODEL_REASONING,
    claudeRouting: process.env.CLAUDE_ROUTING,
    cronSecret: process.env.CRON_SECRET,
    intakeSecret: process.env.INTAKE_SECRET,
  };
}
