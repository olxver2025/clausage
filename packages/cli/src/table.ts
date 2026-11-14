import { c, truncate, visibleWidth } from './format.js';

export type Align = 'left' | 'right' | 'center';

export interface Column {
  header: string;
  align?: Align;
  /** hard cap on content width; longer single-line cells are truncated */
  maxWidth?: number;
}

export interface RowOptions {
  /** draw a separator line above this row */
  separatorBefore?: boolean;
  /** style function applied to each cell (e.g. yellow for totals) */
  style?: (s: string) => string;
}

export interface TableRow {
  cells: string[];
  opts?: RowOptions;
}

const BOX = {
  tl: '┌',
  tm: '┬',
  tr: '┐',
  ml: '├',
  mm: '┼',
  mr: '┤',
  bl: '└',
  bm: '┴',
  br: '┘',
  h: '─',
  v: '│',
};

function pad(s: string, width: number, align: Align): string {
  const w = visibleWidth(s);
  const gap = Math.max(0, width - w);
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + s + ' '.repeat(gap - l);
  }
  return s + ' '.repeat(gap);
}

export class Table {
  private rows: TableRow[] = [];
  constructor(private columns: Column[]) {}

  push(cells: string[], opts?: RowOptions): this {
    this.rows.push({ cells, opts });
    return this;
  }

  get length(): number {
    return this.rows.length;
  }

  /** Width of the rendered table in columns. */
  width(): number {
    return this.widths().reduce((a, b) => a + b + 3, 1);
  }

  private cellLines(s: string, col: Column): string[] {
    const lines = (s ?? '').split('\n');
    return col.maxWidth ? lines.map((l) => truncate(l, col.maxWidth!)) : lines;
  }

  private widths(): number[] {
    return this.columns.map((col, i) => {
      let w = visibleWidth(col.header);
      for (const r of this.rows) {
        for (const line of this.cellLines(r.cells[i] ?? '', col)) w = Math.max(w, visibleWidth(line));
      }
      return w;
    });
  }

  render(): string {
    const widths = this.widths();
    const line = (l: string, m: string, r: string) => c.gray(l + widths.map((w) => BOX.h.repeat(w + 2)).join(m) + r);
    const v = c.gray(BOX.v);
    const renderRow = (cells: string[], style?: (s: string) => string, header = false): string[] => {
      const split = this.columns.map((col, i) => this.cellLines(cells[i] ?? '', col));
      const height = Math.max(1, ...split.map((s) => s.length));
      const out: string[] = [];
      for (let k = 0; k < height; k++) {
        const parts = this.columns.map((col, i) => {
          const raw = split[i]![k] ?? '';
          const align = header ? 'center' : (col.align ?? 'left');
          const styled = style ? style(raw) : raw;
          return ' ' + pad(styled, widths[i]!, align) + ' ';
        });
        out.push(v + parts.join(v) + v);
      }
      return out;
    };
    const out: string[] = [];
    out.push(line(BOX.tl, BOX.tm, BOX.tr));
    out.push(...renderRow(this.columns.map((col) => col.header), (s) => c.cyan(s), true));
    out.push(line(BOX.ml, BOX.mm, BOX.mr));
    for (const r of this.rows) {
      if (r.opts?.separatorBefore) out.push(line(BOX.ml, BOX.mm, BOX.mr));
      out.push(...renderRow(r.cells, r.opts?.style));
    }
    out.push(line(BOX.bl, BOX.bm, BOX.br));
    return out.join('\n');
  }
}
