export interface Span {
  start: number;
  end: number;
}
export interface Diagnostic extends Span {
  title: string;
  message: string;
  hint: string;
}
export class LanguageError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}
export const fail = (span: Span, title: string, message: string, hint: string): never => {
  throw new LanguageError({ ...span, title, message, hint });
};
export interface Token extends Span {
  kind: 'number' | 'id' | 'string' | 'symbol' | 'newline' | 'eof';
  text: string;
  offsets?: number[];
}
/** A number inside an uncertainty clause. An empty unit means the literal's own unit. */
export interface Amount extends Span {
  value: number;
  unit: string;
}
export type Spread =
  | ({ kind: 'plusminus'; width: Amount } & Span)
  | ({ kind: 'range'; low: Amount; high: Amount; coverage?: Amount; named?: boolean } & Span)
  | ({ kind: 'normal'; sd: Amount } & Span)
  | ({ kind: 'lognormal'; factor: Amount } & Span)
  | ({ kind: 'triangular'; low: Amount; high: Amount } & Span);
/** `~ spread @source` or `~ spread assumed`: how uncertain a literal is, and who says so. */
export interface Uncertainty extends Span {
  spread: Spread;
  source?: string;
  /** The `@source` or `assumed` tokens. */
  provenance: Span;
}
export type Expr =
  | ({
      kind: 'number';
      value: number;
      unit: string;
      source?: string;
      uncertainty?: Uncertainty;
    } & Span)
  | ({ kind: 'name'; name: string } & Span)
  | ({ kind: 'binary'; op: string; left: Expr; right: Expr } & Span)
  | ({ kind: 'unary'; op: string; value: Expr } & Span)
  | ({ kind: 'call'; name: string; args: Expr[] } & Span)
  | ({ kind: 'list'; items: Expr[] } & Span)
  | ({ kind: 'convert'; value: Expr; unit: string } & Span);
export type Part = { text: string } | { expr: Expr };
export type Statement =
  | ({
      kind: 'source';
      name: string;
      title: string;
      page?: string;
      url?: string;
      year?: string;
    } & Span)
  | ({ kind: 'binding'; name: string; assume: boolean; value: Expr } & Span)
  | ({ kind: 'function'; name: string; params: string[]; body: Expr } & Span)
  | ({ kind: 'print'; parts: Part[] } & Span);
export interface Program {
  statements: Statement[];
  diagnostics: Diagnostic[];
}
