// Renderização mínima e segura (sem HTML cru) do texto das respostas: negrito, listas, títulos e citações [S1]/[CASO].
import type { ReactNode } from "react";
import { parseBlocks } from "./chat-blocks.ts";

const INLINE = /(\*\*[^*\n]+\*\*|\[(?:S\d+|CASO)\])/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^\[(S\d+|CASO)\]$/.test(part)) return <sup key={i} className="chat-cite">{part.slice(1, -1)}</sup>;
    return part;
  });
}

export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-md">
      {parseBlocks(text).map((b, i) =>
        b.kind === "ul" ? <ul key={i}>{b.items.map((t, k) => <li key={k}>{inline(t)}</li>)}</ul>
        : b.kind === "ol" ? <ol key={i}>{b.items.map((t, k) => <li key={k}>{inline(t)}</li>)}</ol>
        : b.kind === "h" ? <p key={i} className="chat-md-h">{inline(b.text)}</p>
        : <p key={i}>{inline(b.text)}</p>)}
    </div>
  );
}
