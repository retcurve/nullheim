/**
 * Structured errors handed back to agents.
 *
 * An agent that gets a rejection must be able to fix it without guessing, so
 * every failure carries a machine-readable `code`, a JSON `path` into the
 * offending part of the submission, and a human-readable `message`.
 */

export interface ValidationError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export function validationError(
  code: string,
  path: string,
  message: string,
): ValidationError {
  return Object.freeze({ code, path, message });
}

export function asDict(error: ValidationError): Record<string, string> {
  return { code: error.code, path: error.path, message: error.message };
}

/** Accumulates errors so one submission reports every problem at once. */
export class Collector {
  readonly errors: ValidationError[] = [];

  add(code: string, path: string, message: string): void {
    this.errors.push(validationError(code, path, message));
  }

  extend(errors: readonly ValidationError[]): void {
    this.errors.push(...errors);
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }
}
