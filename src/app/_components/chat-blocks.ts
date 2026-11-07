// Analisador de blocos do texto das respostas do chat (puro, testável sem React).
export type Block = { kind: "p"; text: string } | { kind: "h"; text: string } | { kind: "ul"; items: string[] } | { kind: "ol"; items: string[] };

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of src.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) { blocks.push({ kind: "p", text: "" }); continue; }
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      const item = (ul ?? ol)![1]!;
      if (last && last.kind === kind) last.items.push(item); else blocks.push(kind === "ul" ? { kind: "ul", items: [item] } : { kind: "ol", items: [item] });
    } else if (h) blocks.push({ kind: "h", text: h[1]! });
    else if (last && last.kind === "p" && last.text) last.text += ` ${line}`;
    else blocks.push({ kind: "p", text: line });
  }
  return blocks.filter((b) => b.kind === "ul" || b.kind === "ol" || b.text !== "");
}

