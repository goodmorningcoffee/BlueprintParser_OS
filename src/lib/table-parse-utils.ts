/** Escape a CSV cell value (handles commas, quotes, newlines). */
export function escCsv(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/** Download a parsed grid as a CSV file. */
export function exportTableCsv(
  grid: { headers: string[]; rows: Record<string, string>[] },
  pageNumber: number,
) {
  const { headers, rows } = grid;
  const csvRows = [
    headers.map(escCsv).join(","),
    ...rows.map((row) => headers.map((h) => escCsv(row[h] || "")).join(",")),
  ];
  const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `table_page${pageNumber}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export multiple tables as a single CSV (each table on its own "sheet" separated by blank rows). */
export function exportMultiTableCsv(
  tables: { name: string; headers: string[]; rows: Record<string, string>[]; pageNumber: number }[],
  filename: string,
) {
  const sheets: string[] = [];
  for (const table of tables) {
    const header = `# ${escCsv(table.name)} (Page ${table.pageNumber})`;
    const colRow = table.headers.map(escCsv).join(",");
    const dataRows = table.rows.map((row) => table.headers.map((h) => escCsv(row[h] || "")).join(","));
    sheets.push([header, colRow, ...dataRows].join("\n"));
  }
  const csv = sheets.join("\n\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
