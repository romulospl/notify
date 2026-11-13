// Roda uma vez na subida do servidor Next.js.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.RUN_MIGRATIONS !== "true") return;
  const { runMigrations } = await import("./lib/db/migrate");
  await runMigrations();
  console.log("[portal] migrações aplicadas");
}
