// Destino depois do login: aceita só caminhos internos, para não virar open redirect.
export function safeNext(next: string | string[] | undefined, fallback = "/dashboard"): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
