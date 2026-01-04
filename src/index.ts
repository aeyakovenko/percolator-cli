import { createCli } from "./cli.js";

async function main(): Promise<void> {
  const program = createCli();
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
