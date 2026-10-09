/**
 * Minimal CSV writer.
 *
 * Cells beginning with = + - @ (or a tab / carriage return) are prefixed with
 * an apostrophe so spreadsheet programs treat candidate-supplied text as text
 * rather than running it as a formula.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

function escapeCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (typeof value !== 'number' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(','));
  // The byte-order mark makes Excel read the file as UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}
