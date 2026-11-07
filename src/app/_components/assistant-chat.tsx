"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { askAssistantAction } from "../assistente/actions";
import type { AssistantAnswer } from "../../server/assistant/assistant";

type Msg = { role: "user"; text: string } | { role: "bot"; r: AssistantAnswer } | { role: "err"; text: string };

const NOTE: Record<string, string> = {
  esclarecimento: "Preciso de mais contexto",
  fora_do_escopo: "Fora do seu escopo",
  sem_fonte: "Sem fonte encontrada",
  ia_indisponivel: "IA indisponível — somente fontes, sem síntese",
};
const CASE_PATH = /^\/fila\/([0-9a-f-]{36})$/i;

/** Botão circular fixo + chat do assistente interno (somente leitura). Dentro de um caso, herda o contexto dele. */
export function AssistantChat() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  const caseId = CASE_PATH.exec(usePathname())?.[1];

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, pending, open]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q || pending) return;
    setText("");
    setMsgs((m) => [...m, { role: "user", text: q }]);
    const fd = new FormData();
    fd.set("question", q);
    if (caseId) fd.set("caseId", caseId);
    start(async () => {
      const s = await askAssistantAction({ question: q, result: null, error: null }, fd);
      setMsgs((m) => [...m, s.result ? { role: "bot", r: s.result } : { role: "err", text: s.error ?? "Não foi possível consultar agora." }]);
    });
  }

  return (
    <>
      {open && (
        <section className="chat-panel" aria-label="Assistente interno">
          <header>
            <strong>Assistente GoBIA</strong>
            <span>{caseId ? "Usando o contexto deste caso" : "Consulta geral"} · somente leitura</span>
          </header>
          <div className="chat-body" aria-live="polite">
            {msgs.length === 0 && <p className="muted">Pergunte sobre termos, políticas e motivos de encaminhamento. Respondo com fonte e não aprovo nem altero nada.</p>}
            {msgs.map((m, i) => m.role === "user" ? <p key={i} className="chat-user">{m.text}</p> : m.role === "err" ? <p key={i} role="alert" className="chat-bot">{m.text}</p> : (
              <div key={i} className="chat-bot">
                {NOTE[m.r.status] && <strong>{NOTE[m.r.status]}</strong>}
                <p>{m.r.answer}</p>
                {m.r.missing.length > 0 && <p className="muted">Faltou: {m.r.missing.join("; ")}.</p>}
                {m.r.warnings.map((w, k) => <p key={k} className="muted">Aviso: {w}</p>)}
                {m.r.sources.length > 0 && (
                  <details><summary>Fontes ({m.r.sources.length})</summary>
                    <ul>{m.r.sources.map((s) => <li key={s.ref}><strong>[{s.ref}]</strong> {s.title} · {s.sourceRef} · v{s.version}</li>)}</ul>
                  </details>
                )}
              </div>
            ))}
            {pending && <p className="chat-bot muted">Consultando…</p>}
            <div ref={end} />
          </div>
          <form onSubmit={send}>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="Escreva a sua pergunta" aria-label="Pergunta" />
            <button type="submit" disabled={pending || !text.trim()}>Enviar</button>
          </form>
        </section>
      )}
      <button type="button" className="chat-fab" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Fechar assistente" : "Abrir assistente"}>
        {open ? "×" : "?"}
      </button>
    </>
  );
}
