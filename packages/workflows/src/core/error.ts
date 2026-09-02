const ERROR_MAX_LENGTH = 16 * 1024;

export function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, ERROR_MAX_LENGTH);
}
