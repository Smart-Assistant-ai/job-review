import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSheetBackend } from '../server/storage/local';
import { TableStore, type TableDef } from '../server/storage/tables';
import { StorageError, type CellValue, type SheetBackend } from '../server/storage/types';
import './helpers';

const PEOPLE: TableDef = {
  name: 'People',
  idKey: 'id',
  columns: [
    { key: 'id', header: 'Person ID' },
    { key: 'name', header: 'Name' },
    { key: 'age', header: 'Age', type: 'number' },
    { key: 'status', header: 'Status' },
  ],
};
const LOG: TableDef = { name: 'Log', columns: [{ key: 'entry', header: 'Entry' }] };

let dir: string;
let backend: LocalSheetBackend;
let store: TableStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tables-test-'));
  backend = new LocalSheetBackend(dir);
  store = new TableStore(backend, [PEOPLE, LOG], 0);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const person = (id: string, name: string, age = 30, status = 'New') => ({ id, name, age, status });

describe('TableStore', () => {
  it('creates worksheets and header rows on first use', async () => {
    await store.init();
    expect(await backend.readTab('People')).toEqual([['Person ID', 'Name', 'Age', 'Status']]);
    expect(await backend.readTab('Log')).toEqual([['Entry']]);
  });

  it('appends and reads rows, storing numbers as numbers and text as text', async () => {
    await store.append([{ table: 'People', rows: [person('a', '=SUM(1,2)', 41)] }]);
    expect((await backend.readTab('People'))[1]).toEqual(['a', '=SUM(1,2)', 41, 'New']);
    expect(await store.read('People')).toEqual([{ id: 'a', name: '=SUM(1,2)', age: '41', status: 'New' }]);
  });

  it('updates the right row after the sheet has been sorted by hand', async () => {
    await store.append([{ table: 'People', rows: [person('a', 'Ann'), person('b', 'Bob'), person('c', 'Cy')] }]);
    // Simulate an administrator sorting the rows in reverse.
    const [header, ...rows] = await backend.readTab('People');
    await backend.writeCells(
      'People',
      rows.reverse().flatMap((row, r) => row.map((value, c) => ({ row: r + 1, col: c, value }))),
    );
    expect((await backend.readTab('People'))[0]).toEqual(header);

    const result = await store.updateById('People', [{ id: 'a', patch: { status: 'Hired' } }]);
    expect(result.notFound).toEqual([]);
    const after = await store.read('People');
    expect(after.find((p) => p.id === 'a')?.status).toBe('Hired');
    expect(after.filter((p) => p.id !== 'a').every((p) => p.status === 'New')).toBe(true);
  });

  it('keeps working when columns are reordered and extra columns are added', async () => {
    await store.append([{ table: 'People', rows: [person('a', 'Ann', 25)] }]);
    // Administrator inserts their own column first and moves Status before Name.
    const cells = [
      ['My Rating', 'Person ID', 'Status', 'Name', 'Age'],
      ['5 stars', 'a', 'New', 'Ann', 25],
    ].flatMap((row, r) => row.map((value, c) => ({ row: r, col: c, value: value as CellValue })));
    await backend.writeCells('People', cells);

    await store.append([{ table: 'People', rows: [person('b', 'Bob', 52)] }]);
    await store.updateById('People', [{ id: 'a', patch: { status: 'Rejected', age: 26 } }]);

    const raw = await backend.readTab('People');
    expect(raw[1]).toEqual(['5 stars', 'a', 'Rejected', 'Ann', 26]);
    expect(raw[2]).toEqual(['', 'b', 'New', 'Bob', 52]);
    expect(await store.read('People')).toEqual([
      { id: 'a', name: 'Ann', age: '26', status: 'Rejected' },
      { id: 'b', name: 'Bob', age: '52', status: 'New' },
    ]);
  });

  it('restores a header that was renamed in the sheet', async () => {
    await store.append([{ table: 'People', rows: [person('a', 'Ann')] }]);
    await backend.writeCells('People', [{ row: 0, col: 3, value: 'Stage' }]);
    const rows = await store.read('People');
    expect(rows[0].status).toBe('');
    expect((await backend.readTab('People'))[0]).toEqual(['Person ID', 'Name', 'Age', 'Stage', 'Status']);
  });

  it('ignores blank rows and rows without an ID', async () => {
    await store.append([{ table: 'People', rows: [person('a', 'Ann')] }]);
    await backend.appendRows([{ tab: 'People', rows: [[], ['', 'note typed by hand'], ['  ']] }]);
    expect((await store.read('People')).map((p) => p.id)).toEqual(['a']);
  });

  it('reports IDs that no longer exist instead of writing anywhere', async () => {
    await store.append([{ table: 'People', rows: [person('a', 'Ann')] }]);
    const before = await backend.readTab('People');
    const result = await store.updateById('People', [{ id: 'zzz', patch: { status: 'Hired' } }]);
    expect(result.notFound).toEqual(['zzz']);
    expect(await backend.readTab('People')).toEqual(before);
  });

  it('writes to several tables in one call', async () => {
    await store.append([
      { table: 'People', rows: [person('a', 'Ann')] },
      { table: 'Log', rows: [{ entry: 'created a' }] },
    ]);
    expect(await store.read('Log')).toEqual([{ entry: 'created a' }]);
  });

  it('does not lose rows when many appends run at once', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => store.append([{ table: 'People', rows: [person(`id${i}`, `P${i}`)] }])),
    );
    const ids = (await store.read('People')).map((p) => p.id);
    expect(new Set(ids).size).toBe(40);
  });
});

/** Wraps a backend so chosen calls fail, optionally after the write has already happened. */
function flaky(inner: SheetBackend, plan: { appendFailures: number; writeBeforeFailing: boolean; kind?: 'unavailable' | 'unknown' }): SheetBackend & { appendCalls: number } {
  return {
    appendCalls: 0,
    ensureTabs: (n) => inner.ensureTabs(n),
    readTab: (t) => inner.readTab(t),
    writeCells: (t, c) => inner.writeCells(t, c),
    async appendRows(appends) {
      this.appendCalls += 1;
      if (plan.appendFailures > 0) {
        plan.appendFailures -= 1;
        if (plan.writeBeforeFailing) await inner.appendRows(appends);
        throw new StorageError(plan.kind ?? 'unavailable', 'simulated failure');
      }
      return inner.appendRows(appends);
    },
  };
}

describe('TableStore retries', () => {
  it('retries a transient failure and writes the row exactly once', async () => {
    const wrapped = flaky(backend, { appendFailures: 2, writeBeforeFailing: false });
    const s = new TableStore(wrapped, [PEOPLE], 0);
    const exists = async () => (await s.read('People', { fresh: true })).some((p) => p.id === 'a');
    await s.append([{ table: 'People', rows: [person('a', 'Ann')] }], { alreadyDone: exists });
    expect(wrapped.appendCalls).toBe(3);
    expect((await s.read('People')).length).toBe(1);
  });

  it('does not write twice when the failed call had actually gone through', async () => {
    const wrapped = flaky(backend, { appendFailures: 1, writeBeforeFailing: true });
    const s = new TableStore(wrapped, [PEOPLE], 0);
    const exists = async () => (await s.read('People', { fresh: true })).some((p) => p.id === 'a');
    await s.append([{ table: 'People', rows: [person('a', 'Ann')] }], { alreadyDone: exists });
    expect(wrapped.appendCalls).toBe(1);
    expect((await s.read('People')).length).toBe(1);
  });

  it('never retries an append without a way to check for duplicates', async () => {
    const wrapped = flaky(backend, { appendFailures: 1, writeBeforeFailing: false });
    const s = new TableStore(wrapped, [PEOPLE], 0);
    await expect(s.append([{ table: 'People', rows: [person('a', 'Ann')] }])).rejects.toThrow('simulated failure');
    expect(wrapped.appendCalls).toBe(1);
  });

  it('gives up immediately on errors that retrying cannot fix', async () => {
    const wrapped = flaky(backend, { appendFailures: 5, writeBeforeFailing: false, kind: 'unknown' });
    const s = new TableStore(wrapped, [PEOPLE], 0);
    await expect(
      s.append([{ table: 'People', rows: [person('a', 'Ann')] }], { alreadyDone: async () => false }),
    ).rejects.toThrow('simulated failure');
    expect(wrapped.appendCalls).toBe(1);
  });

  it('keeps accepting writes after one fails', async () => {
    const wrapped = flaky(backend, { appendFailures: 1, writeBeforeFailing: false, kind: 'unknown' });
    const s = new TableStore(wrapped, [PEOPLE], 0);
    await expect(s.append([{ table: 'People', rows: [person('a', 'Ann')] }])).rejects.toThrow();
    await s.append([{ table: 'People', rows: [person('b', 'Bob')] }]);
    expect((await s.read('People')).map((p) => p.id)).toEqual(['b']);
  });
});
