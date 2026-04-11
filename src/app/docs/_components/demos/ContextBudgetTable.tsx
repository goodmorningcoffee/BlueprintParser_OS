import { TableEl } from "../TableEl";
import { CONTEXT_BUDGET_ROWS } from "../constants";

/** Budgets in chars per model, sourced from getContextBudget() in
 *  src/lib/context-builder.ts:16-42. Tokens column is a rough 4:1 estimate. */
export function ContextBudgetTable() {
  return (
    <TableEl
      headers={["Provider", "Model", "Char budget", "~Tokens"]}
      rows={CONTEXT_BUDGET_ROWS.map((r) => [
        <span key={r.provider} className="font-mono text-[var(--accent)]">{r.provider}</span>,
        <span key={r.model} className="font-mono">{r.model}</span>,
        <span key="chars" className="font-mono tabular-nums">{r.chars.toLocaleString()}</span>,
        <span key="tok" className="font-mono tabular-nums text-[var(--muted)]">
          ~{Math.round(r.chars / 4).toLocaleString()}
        </span>,
      ])}
      dense
    />
  );
}
