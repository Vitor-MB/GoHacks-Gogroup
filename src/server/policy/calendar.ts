// GOB-06 · Calendário em dias úteis. Regras puras, sem banco nem relógio do sistema.
// Dia útil = não é sábado, domingo nem feriado nacional da política vigente (prazos_entrega.feriados_nacionais).
// Datas são strings YYYY-MM-DD (America/Sao_Paulo); o chamador informa os feriados lidos da política.

export type Holidays = ReadonlySet<string>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse(date: string): number {
  if (!DATE.test(date)) throw new Error(`data inválida: ${date}`);
  const t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  if (new Date(t).toISOString().slice(0, 10) !== date) throw new Error(`data inexistente: ${date}`);
  return t;
}
const fmt = (t: number): string => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;

/** Lê a lista da política ("2026-09-07; 2026-10-12; ..."). */
export function parseHolidays(list: string): Holidays {
  const out = new Set<string>();
  for (const part of list.split(";")) {
    const d = part.trim();
    if (!d) continue;
    parse(d);
    out.add(d);
  }
  return out;
}

export function isBusinessDay(date: string, holidays: Holidays): boolean {
  const dow = new Date(parse(date)).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(date);
}

/** Soma `n` dias úteis a partir de `date` (n ≥ 0). O dia inicial nunca conta; `n = 0` devolve a própria data. */
export function addBusinessDays(date: string, n: number, holidays: Holidays): string {
  if (!Number.isInteger(n) || n < 0) throw new Error("n deve ser inteiro não negativo");
  let t = parse(date);
  let left = n;
  while (left > 0) {
    t += DAY;
    if (isBusinessDay(fmt(t), holidays)) left--;
  }
  return fmt(t);
}

/** Dias úteis em (from, to]: exclui o dia inicial e inclui o final. Zero quando `to` não é posterior a `from`. */
export function businessDaysBetween(from: string, to: string, holidays: Holidays): number {
  const end = parse(to);
  let n = 0;
  for (let t = parse(from) + DAY; t <= end; t += DAY) if (isBusinessDay(fmt(t), holidays)) n++;
  return n;
}

/**
 * Prazo prometido da política: data do pedido + dias úteis de preparo + SLA da transportadora (dias úteis),
 * contados a partir do primeiro dia útil depois do pedido.
 */
export function promisedDate(orderDate: string, prepDays: number, carrierDays: number, holidays: Holidays): string {
  return addBusinessDays(orderDate, prepDays + carrierDays, holidays);
}

/** Dias corridos entre duas datas (to − from). */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / DAY);
}
