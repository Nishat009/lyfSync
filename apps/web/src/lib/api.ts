import type { ApiErrorBody } from "@lifesync/shared";
import type { FieldValues, Path, UseFormSetError } from "react-hook-form";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown };

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      credentials: "same-origin",
      headers: opts.body !== undefined && !isForm ? { "Content-Type": "application/json" } : undefined,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  const json = text ? safeParse(text) : null;
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? "Something went wrong", err?.fields);
  }
  return json as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Puts server-side field errors on the matching form fields; returns the message to show otherwise. */
export function applyFormError<T extends FieldValues>(err: unknown, setError: UseFormSetError<T>): string {
  if (err instanceof ApiError && err.fields) {
    for (const [name, message] of Object.entries(err.fields)) {
      setError(name as Path<T>, { message });
    }
    // Don't repeat a message that is already shown next to its field.
    return Object.values(err.fields).includes(err.message) ? "" : err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong";
}
