export type DomainErrorCode =
  | "duplicate-id"
  | "invalid-command"
  | "invalid-reference"
  | "not-found"
  | "conflicting-save"
  | "dependent-references";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly path?: string;
  readonly references?: string[];

  constructor(
    code: DomainErrorCode,
    message: string,
    options: { path?: string; references?: string[] } = {}
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.path = options.path;
    this.references = options.references;
  }
}
