// Runs once when the Next.js server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.RUN_MIGRATIONS !== "true") return;
  const { runMigrations, runDevSeed } = await import("./lib/db/migrate");
  await runMigrations();
  console.log("[portal] migrations applied");
  if (process.env.SEED_DEV_DATA === "true") {
    await runDevSeed();
    console.log("[portal] development accounts applied");
  }
}
