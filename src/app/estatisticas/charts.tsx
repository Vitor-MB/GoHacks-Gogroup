// Componentes de gráfico das estatísticas: HTML/CSS no servidor, sem biblioteca. Cada gráfico traz os valores na tela
// e uma tabela equivalente para leitores de tela.
import type { ReactNode } from "react";

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pink" | "muted" }) {
  return (
    <div className={`st-kpi${tone ? ` st-kpi-${tone}` : ""}`}>
      <span className="st-kpi-label">{label}</span>
      <strong>{value}</strong>
      {sub && <span className="st-kpi-sub">{sub}</span>}
    </div>
  );
}

export function ChartCard({ title, sub, children, wide }: { title: string; sub?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`st-card${wide ? " st-wide" : ""}`}>
      <h3>{title}</h3>
      {sub && <p className="st-card-sub">{sub}</p>}
      {children}
    </section>
  );
}

export const Empty = ({ text = "Sem dados neste filtro." }: { text?: string }) => <p className="st-empty">{text}</p>;

export interface Bar { label: string; value: number; display?: string; tone?: string }

/** Barras horizontais. `max` fixa a escala (ex.: 100 para percentuais); por padrão, o maior valor. */
export function BarsH({ rows, max, name }: { rows: Bar[]; max?: number; name: string }) {
  if (rows.length === 0 || rows.every((r) => r.value === 0 && !r.display)) return <Empty />;
  const top = max ?? Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="st-bars" role="group" aria-label={name}>
      {rows.map((r) => (
        <div key={r.label} className="st-bar-row">
          <span className="st-bar-label">{r.label}</span>
          <span className="st-bar-track"><span className={`st-bar-fill st-tone-${r.tone ?? "blue"}`} style={{ width: `${Math.min(100, (r.value / top) * 100)}%` }} /></span>
          <span className="st-bar-value">{r.display ?? r.value}</span>
        </div>
      ))}
    </div>
  );
}

export interface Col { label: string; a: number; b: number }

/** Colunas empilhadas (a azul, b rosa) com o total no topo. */
export function ColumnsStacked({ data, aLabel, bLabel, name }: { data: Col[]; aLabel: string; bLabel: string; name: string }) {
  if (data.length === 0) return <Empty text="Nenhum registro no período." />;
  const top = Math.max(...data.map((d) => d.a + d.b), 1);
  return (
    <figure className="st-cols-fig" aria-label={name}>
      <div className="st-cols">
        {data.map((d) => (
          <div key={d.label} className="st-col">
            <span className="st-col-total">{d.a + d.b}</span>
            <div className="st-col-stack" style={{ height: `${((d.a + d.b) / top) * 100}%` }}>
              <span className="st-seg st-tone-pink" style={{ flex: d.b }} title={`${bLabel}: ${d.b}`} />
              <span className="st-seg st-tone-blue" style={{ flex: d.a }} title={`${aLabel}: ${d.a}`} />
            </div>
            <span className="st-col-label">{d.label}</span>
          </div>
        ))}
      </div>
      <figcaption className="st-legend"><span><i className="st-tone-blue" />{aLabel}</span><span><i className="st-tone-pink" />{bLabel}</span></figcaption>
      <table className="sr-only">
        <caption>{name}</caption>
        <thead><tr><th>Período</th><th>{aLabel}</th><th>{bLabel}</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td>{d.a}</td><td>{d.b}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
