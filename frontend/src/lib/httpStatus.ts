/** 404 and 410 both mean the resource is gone for good (the query client drops it too). */
export const isNotFoundStatus = (status: number | null | undefined): boolean =>
  status === 404 || status === 410;

/** The HTTP status carried by an `ApiError`-shaped failure, null for anything else. */
export function errorHttpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}
