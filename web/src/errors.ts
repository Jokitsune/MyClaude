/** Erreur HTTP renvoyée par l'API locale (`{ error: string }`). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "Une erreur inattendue s'est produite.";
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}
