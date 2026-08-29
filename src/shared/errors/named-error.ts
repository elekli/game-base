export class NamedError extends Error {
  readonly code: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "NamedError";
    this.code = code;
  }
}
