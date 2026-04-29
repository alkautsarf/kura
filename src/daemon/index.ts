import { start } from "./server.ts";

export async function run(): Promise<void> {
  const handle = await start();
  console.log(`kura daemon listening on ${handle.scheme}://${handle.host}:${handle.port}`);
  if (handle.proxy) {
    console.log(`csp-strip proxy listening on http://${handle.proxy.host}:${handle.proxy.port} for ${handle.proxy.domains.join(", ")}`);
  }
  console.log(`pid ${process.pid}`);
  const shutdown = async (signal: string) => {
    console.log(`\nreceived ${signal}, stopping daemon`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await new Promise<void>(() => {});
}
