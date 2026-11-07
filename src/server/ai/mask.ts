// GOB-07 · Mascaramento de dados pessoais antes de qualquer envio ao modelo (política dados_pessoais.mascarar_antes_de_enviar_a_modelos).
// Puro e determinístico. Cobre cartão, CPF, telefone e e-mail em texto livre e remove chaves sensíveis de objetos.

const CARD = /(?<![\w])(?:\d[ -]?){12}\d{1,6}(?![\w])/g;
const CPF = /(?<![\w])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\w])/g;
const PHONE = /(?<![\w])(?:\+?55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}(?![\w])/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export function maskText(text: string): string {
  return text
    .replace(EMAIL, "[EMAIL]")
    .replace(CARD, (m) => (m.replace(/\D/g, "").length >= 13 ? "[CARTAO]" : m))
    .replace(CPF, "[CPF]")
    .replace(PHONE, "[TELEFONE]");
}

const SENSITIVE_KEY = /cpf|cartao|card|phone|telefone|email|e_mail|nascimento/i;

/** Mascara strings e remove o valor de chaves sensíveis, em qualquer profundidade. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskText(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) && v != null ? "[OMITIDO]" : maskDeep(v);
    return out as T;
  }
  return value;
}
