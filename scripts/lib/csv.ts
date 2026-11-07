// Leitura de CSV (RFC 4180) sem dependências: aspas, aspas duplicadas e quebras de linha dentro de campos.
// Todos os valores permanecem como texto; a conversão de tipos é explícita em cada mapeamento.
import { readFileSync } from "node:fs";

export type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.length > 1 || record[0] !== "") records.push(record);
      record = [];
    } else field += ch;
  }
  if (quoted) throw new Error("CSV com aspas não fechadas.");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const [header, ...body] = records;
  if (!header) return [];
  return body.map((values, n) => {
    if (values.length !== header.length) {
      throw new Error(`Linha ${n + 2}: ${values.length} colunas, esperado ${header.length}.`);
    }
    const row: Row = {};
    header.forEach((name, idx) => (row[name.trim()] = values[idx]));
    return row;
  });
}

export function readCsv(path: string): Row[] {
  return parseCsv(readFileSync(path, "utf8"));
}

// ---- Conversões explícitas ----

/** Vazio → null. */
export function text(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/** "119.90" → 11990, sem passar por ponto flutuante. */
export function cents(v: string | undefined): number | null {
  const t = text(v);
  if (t === null) return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) throw new Error(`Valor monetário inválido: "${v}"`);
  const value = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] ? -value : value;
}

export function int(v: string | undefined): number | null {
  const t = text(v);
  if (t === null) return null;
  if (!/^-?\d+$/.test(t)) throw new Error(`Inteiro inválido: "${v}"`);
  return Number(t);
}

export function yesNo(v: string | undefined): boolean | null {
  const t = text(v)?.toLowerCase();
  if (t === undefined || t === null) return null;
  if (t === "sim") return true;
  if (t === "não" || t === "nao") return false;
  throw new Error(`Valor sim/não inválido: "${v}"`);
}

/** "AAAA-MM-DD" (sem horário) → mesma data. */
export function date(v: string | undefined): string | null {
  const t = text(v);
  if (t === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error(`Data inválida: "${v}"`);
  return t;
}

/** Horários da base estão em America/Sao_Paulo (UTC-3, sem horário de verão em 2026). */
export function timestamp(v: string | undefined): string | null {
  const t = text(v);
  if (t === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) throw new Error(`Data/hora inválida: "${v}"`);
  return `${m[1]}T${m[2]}:${m[3] ?? "00"}-03:00`;
}

/** "Barbour's" → "barbours", "By Samia" → "by-samia", "Auá" → "aua". */
export function slug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
