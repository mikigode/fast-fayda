import { getPool, migrate } from "./db";

/**
 * Applies migrations and exits. `npm run migrate`.
 *
 * The long-running server does this at boot, but a serverless deployment has no
 * boot — so on Vercel this is the deploy step that replaces it. Safe to run
 * repeatedly: it applies only what is missing, under an advisory lock.
 */
async function main() {
  const applied = await migrate();
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Schema up to date.");
  await getPool().end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
