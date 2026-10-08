export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const unauthenticated = () =>
  new ApiError(401, "unauthenticated", "Sign in again.");
export const unavailable = () =>
  new ApiError(503, "unavailable", "Authentication or storage is unavailable.");
