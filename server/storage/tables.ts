import { withRetry, withVerifiedRetry } from './retry';
import type { CellValue, SheetBackend } from './types';

export interface ColumnDef {
  /** Name used in code. */
  key: string;
  /** Header text shown in the spreadsheet. Columns are located by this text, not by position. */
  header: string;
  type?: 'number';
}

export interface TableDef {
  /** Worksheet (tab) name. */
  name: string;
  /** Column holding the stable unique ID, for tables whose rows are updated later. */
  idKey?: string;
  columns: ColumnDef[];
}

export type Row = Record<string, string>;

interface LoadedTable {
  def: TableDef;
  /** Column key -> zero-based column position in the sheet right now. */
  columnIndex: Map<string, number>;
  width: number;
  rows: { index: number; values: Row }[];
}

const normalizeHeader = (value: unknown) => String(value ?? '').trim().toLowerCase();

/**
 * Treats spreadsheet tabs as tables.
 *
 * Nothing here depends on where a row or column currently sits: columns are
 * matched by header text and rows by ID, both resolved against a fresh read
 * immediately before every update. Administrators can therefore sort rows,
 * reorder columns or add their own columns without breaking the app.
 */
export class TableStore {
  private readonly defs = new Map<string, TableDef>();
  private readonly cache = new Map<string, { loadedAt: number; table: LoadedTable }>();
  private readonly inflight = new Map<string, Promise<LoadedTable>>();
  private readonly versions = new Map<string, number>();
  private initPromise: Promise<void> | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: SheetBackend,
    defs: TableDef[],
    private readonly cacheTtlMs = 15_000,
  ) {
    for (const def of defs) this.defs.set(def.name, def);
  }

  /** Creates missing tabs and header columns. Safe to call repeatedly. */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    await withRetry(() => this.backend.ensureTabs([...this.defs.keys()]));
    for (const def of this.defs.values()) {
      const values = await withRetry(() => this.backend.readTab(def.name));
      await this.addMissingHeaders(def, values);
    }
  }

  private async addMissingHeaders(def: TableDef, values: CellValue[][]): Promise<boolean> {
    const present = new Set((values[0] ?? []).map(normalizeHeader));
    const missing = def.columns.filter((c) => !present.has(normalizeHeader(c.header)));
    if (missing.length === 0) return false;
    // Start after the widest existing row so stray data is never given a header by accident.
    const start = values.reduce((max, row) => Math.max(max, row.length), 0);
    await withRetry(() =>
      this.backend.writeCells(
        def.name,
        missing.map((c, i) => ({ row: 0, col: start + i, value: c.header })),
      ),
    );
    return true;
  }

  private def(name: string): TableDef {
    const def = this.defs.get(name);
    if (!def) throw new Error(`Unknown table "${name}"`);
    return def;
  }

  private parse(def: TableDef, values: CellValue[][]): LoadedTable {
    const headerRow = values[0] ?? [];
    const byHeader = new Map(def.columns.map((c) => [normalizeHeader(c.header), c.key]));
    const columnIndex = new Map<string, number>();
    headerRow.forEach((cell, i) => {
      const key = byHeader.get(normalizeHeader(cell));
      if (key && !columnIndex.has(key)) columnIndex.set(key, i);
    });

    const rows: LoadedTable['rows'] = [];
    let width = headerRow.length;
    for (let i = 1; i < values.length; i++) {
      const raw = values[i] ?? [];
      width = Math.max(width, raw.length);
      const row: Row = {};
      let hasData = false;
      for (const col of def.columns) {
        const idx = columnIndex.get(col.key);
        const cell = idx === undefined ? undefined : raw[idx];
        const text = cell === undefined || cell === null ? '' : String(cell);
        row[col.key] = text;
        if (text !== '') hasData = true;
      }
      if (!hasData) continue;
      if (def.idKey) {
        row[def.idKey] = row[def.idKey].trim();
        // Rows without an ID are not ours (for example notes typed below the data).
        if (!row[def.idKey]) continue;
      }
      rows.push({ index: i, values: row });
    }
    return { def, columnIndex, width, rows };
  }

  private async fetchTable(name: string): Promise<LoadedTable> {
    const def = this.def(name);
    const version = this.versions.get(name) ?? 0;
    let values = await withRetry(() => this.backend.readTab(name));
    let table = this.parse(def, values);
    if (table.columnIndex.size < def.columns.length) {
      // A header was renamed or removed in the sheet: put it back, then read again.
      await this.addMissingHeaders(def, values);
      values = await withRetry(() => this.backend.readTab(name));
      table = this.parse(def, values);
    }
    // Do not cache a snapshot that a write has since made stale.
    if ((this.versions.get(name) ?? 0) === version) {
      this.cache.set(name, { loadedAt: Date.now(), table });
    }
    return table;
  }

  private async load(name: string, fresh = false): Promise<LoadedTable> {
    await this.init();
    if (!fresh) {
      const cached = this.cache.get(name);
      if (cached && Date.now() - cached.loadedAt < this.cacheTtlMs) return cached.table;
      const pending = this.inflight.get(name);
      if (pending) return pending;
    }
    const promise = this.fetchTable(name).finally(() => {
      if (this.inflight.get(name) === promise) this.inflight.delete(name);
    });
    this.inflight.set(name, promise);
    return promise;
  }

  private invalidate(name: string): void {
    this.cache.delete(name);
    this.inflight.delete(name);
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
  }

  /** Runs write operations one at a time so they cannot interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private normalizeValue(col: ColumnDef, value: CellValue | undefined | null): CellValue {
    if (value === undefined || value === null || value === '') return '';
    if (col.type === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : '';
    }
    return String(value);
  }

  /** Returns all rows of a table as plain objects keyed by column key. */
  async read(name: string, options: { fresh?: boolean } = {}): Promise<Row[]> {
    const table = await this.load(name, options.fresh);
    return table.rows.map((r) => r.values);
  }

  /**
   * Appends rows to one or more tables in a single all-or-nothing write.
   *
   * Appending is not safe to repeat blindly, so a failed write is only retried
   * when the caller says how to check whether it went through (`alreadyDone`)
   * or declares that a duplicate row would do no harm.
   */
  async append(
    batches: { table: string; rows: Record<string, CellValue>[] }[],
    options: { alreadyDone?: () => Promise<boolean>; duplicatesHarmless?: boolean } = {},
  ): Promise<void> {
    const nonEmpty = batches.filter((b) => b.rows.length > 0);
    if (nonEmpty.length === 0) return;

    await this.enqueue(async () => {
      const payload: { tab: string; rows: CellValue[][] }[] = [];
      for (const batch of nonEmpty) {
        const table = await this.load(batch.table);
        payload.push({
          tab: batch.table,
          rows: batch.rows.map((record) => {
            const out: CellValue[] = new Array(table.width).fill('');
            for (const col of table.def.columns) {
              const idx = table.columnIndex.get(col.key);
              if (idx !== undefined) out[idx] = this.normalizeValue(col, record[col.key]);
            }
            return out;
          }),
        });
      }
      const write = () => this.backend.appendRows(payload);
      try {
        if (options.alreadyDone) await withVerifiedRetry(write, options.alreadyDone);
        else if (options.duplicatesHarmless) await withRetry(write);
        else await write();
      } finally {
        for (const batch of nonEmpty) this.invalidate(batch.table);
      }
    });
  }

  /**
   * Updates cells of rows identified by ID. Row positions are looked up from a
   * fresh read right before writing. Returns the IDs that no longer exist.
   */
  async updateById(
    name: string,
    updates: { id: string; patch: Record<string, CellValue> }[],
  ): Promise<{ notFound: string[] }> {
    const def = this.def(name);
    const idKey = def.idKey;
    if (!idKey) throw new Error(`Table "${name}" has no ID column`);
    if (updates.length === 0) return { notFound: [] };

    return this.enqueue(async () => {
      const table = await this.load(name, true);
      const rowIndexById = new Map(table.rows.map((r) => [r.values[idKey], r.index]));
      const cells: { row: number; col: number; value: CellValue }[] = [];
      const notFound: string[] = [];

      for (const update of updates) {
        const row = rowIndexById.get(update.id);
        if (row === undefined) {
          notFound.push(update.id);
          continue;
        }
        for (const [key, value] of Object.entries(update.patch)) {
          const col = def.columns.find((c) => c.key === key);
          const idx = table.columnIndex.get(key);
          if (!col || idx === undefined) throw new Error(`Unknown column "${key}" in table "${name}"`);
          cells.push({ row, col: idx, value: this.normalizeValue(col, value) });
        }
      }

      if (cells.length > 0) {
        try {
          await withRetry(() => this.backend.writeCells(name, cells));
        } finally {
          this.invalidate(name);
        }
      }
      return { notFound };
    });
  }
}
