/** A value that starts like a formula is quoted as text, so a spreadsheet never runs something typed into a name. */
const cell = (v: string | number) => {
  const s = String(v);
  const safe = typeof v === 'string' && /^[=+@\t\r-]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Saves rows as a file Excel opens. The leading mark makes Excel read non-English names correctly. */
export function downloadCsv(name: string, rows: (string | number)[][]) {
  const blob = new Blob(['\uFEFF', rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
