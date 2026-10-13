export function clientStateErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  if (Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599) return Number(status);
  if (error instanceof Error && error.message === "Request is too large") return 413;
  return 409;
}
