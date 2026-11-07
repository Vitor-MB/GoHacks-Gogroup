// Chat: verificação do analisador de blocos do texto das respostas. Uso: node scripts/verify-chat-markdown.ts
import { parseBlocks } from "../src/app/_components/chat-blocks.ts";
let failed = 0;
const ok = (c: boolean, n: string) => { if (!c) failed++; console.log(`${c ? "OK  " : "FALHA"} ${n}`); };
const b = parseBlocks("**Políticas:**\n\n**Cancelamento [S1]**\n- Antes da separação: estorno\n- Depois: 7 dias\n\n1. Um\n2. Dois\nlinha\ncontinua\n## Título");
ok(b.map((x) => x.kind).join() === "p,p,ul,ol,p,h", "parágrafos, listas, título");
ok(b[2]!.kind === "ul" && (b[2] as { items: string[] }).items.length === 2, "itens agrupados na lista");
ok((b[4] as { text: string }).text === "linha continua", "linhas seguidas viram um parágrafo");
ok(parseBlocks("<script>x</script>")[0]!.kind === "p", "HTML cru segue como texto (renderizado sem innerHTML)");
console.log(failed ? `${failed} falha(s).` : "Tudo certo.");
process.exit(failed ? 1 : 0);
