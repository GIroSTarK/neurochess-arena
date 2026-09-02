import type { DomainErrorCode, DomainResult } from "./types.js";

export function success<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}

export function failure(code: DomainErrorCode, ply?: number): DomainResult<never> {
  return { ok: false, error: ply === undefined ? { code } : { code, ply } };
}
