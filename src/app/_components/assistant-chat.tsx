"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { askAssistantAction } from "../assistente/actions";
import { ChatMarkdown } from "./chat-markdown";
import type { AssistantAnswer } from "../../server/assistant/assistant";

type Msg = { role: "user"; text: string } | { role: "bot"; r: AssistantAnswer } | { role: "err"; text: string };

const NOTE: Record<string, { text: string; tone: "info" | "warn" }> = {
  esclarecimento: { text: "Preciso de mais contexto", tone: "info" },
  fora_do_escopo: { text: "Fora do seu escopo", tone: "warn" },
  sem_fonte: { text: "Sem fonte encontrada", tone: "warn" },
  ia_indisponivel: { text: "IA indisponível: somente fontes, sem síntese", tone: "warn" },
};
const CASE_PATH = /^\/fila\/([0-9a-f-]{36})$/i;
const SUGGESTIONS = ["Quais os prazos por canal?", "Qual a alçada de reembolso do agente?", "Quando acionar a supervisão?"];
const CASE_SUGGESTIONS = ["Por que este caso foi encaminhado?", "Posso aprovar esta proposta?", "Qual política se aplica aqui?"];

const Avatar = () => <span className="chat-avatar" aria-hidden="true">G</span>;

/** Botão fixo + chat do assistente interno (somente leitura). Dentro de um caso, herda o contexto dele. */
export function AssistantChat() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  const caseId = CASE_PATH.exec(usePathname())?.[1];

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, pending, open]);

  function ask(raw: string) {
    const q = raw.trim();
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
          <header className="chat-head">
            <Avatar />
            <div>
              <strong>GoBIA</strong>
              <span>{caseId ? "Usando o contexto deste caso" : "Tire dúvidas sobre diretrizes e políticas"}</span>
            </div>
            <button type="button" className="chat-close" onClick={() => setOpen(false)} aria-label="Fechar assistente">×</button>
          </header>
          <div className="chat-body" aria-live="polite">
            {msgs.length === 0 && (
              <div className="chat-welcome">
                <p>Olá! Respondo com a fonte da política. Só leio e explico: não aprovo nem altero nada.</p>
                <span className="chat-sugg-title">Perguntas frequentes</span>
                <div className="chat-suggs">
                  {(caseId ? CASE_SUGGESTIONS : SUGGESTIONS).map((s) => <button key={s} type="button" onClick={() => ask(s)}>{s}</button>)}
                </div>
              </div>
            )}
            {msgs.map((m, i) => m.role === "user" ? <p key={i} className="chat-user">{m.text}</p> : m.role === "err" ? (
              <div key={i} className="chat-row"><Avatar /><p role="alert" className="chat-bot">{m.text}</p></div>
            ) : (
              <div key={i} className="chat-row">
                <Avatar />
                <div className="chat-bot">
                  {NOTE[m.r.status] && <span className={`chat-badge chat-badge-${NOTE[m.r.status]!.tone}`}>{NOTE[m.r.status]!.text}</span>}
                  <ChatMarkdown text={m.r.answer} />
                  {m.r.missing.length > 0 && <p className="chat-meta">Faltou: {m.r.missing.join("; ")}.</p>}
                  {m.r.warnings.map((w, k) => <p key={k} className="chat-meta">Aviso: {w}</p>)}
                  {m.r.sources.length > 0 && (
                    <div className="chat-sources">
                      <span className="chat-sugg-title">Fontes</span>
                      {m.r.sources.map((s) => (
                        <span key={s.ref} className="chat-source" title={s.snippet}><b>{s.ref}</b> {s.title}<small>{s.sourceRef} · v{s.version}</small></span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {pending && <div className="chat-row"><Avatar /><p className="chat-bot chat-typing" aria-label="Consultando"><i /><i /><i /></p></div>}
            <div ref={end} />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); ask(text); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="Pergunte sobre diretrizes e políticas" aria-label="Pergunta" />
            <button type="submit" disabled={pending || !text.trim()} aria-label="Enviar">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></svg>
            </button>
          </form>
        </section>
      )}
      <button type="button" className="chat-fab" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Fechar assistente" : "Abrir assistente"}>
        {open ? "×" : <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>}
      </button>
    </>
  );
}
