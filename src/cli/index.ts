import mri from "mri";
import { COLOR } from "./format.ts";
import { checkDaemon } from "./client.ts";

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    console.error("missing subcommand");
    process.exit(1);
  }

  if (cmd !== "init" && cmd !== "daemon" && cmd !== "popup" && cmd !== "proxy") {
    const ok = await checkDaemon();
    if (!ok) {
      console.error(`${COLOR.red}daemon not reachable${COLOR.reset}`);
      console.error(`run ${COLOR.bold}kura daemon${COLOR.reset} in another pane first.`);
      process.exit(1);
    }
  }

  try {
    switch (cmd) {
      case "balance": {
        const args = mri<any>(rest, { string: ["address", "wallet"], alias: { c: "chain", w: "wallet", a: "address" } });
        const { run } = await import("./commands/balance.ts");
        return await run(args);
      }
      case "history": {
        const args = mri<any>(rest, { string: ["address", "wallet"], alias: { c: "chain", w: "wallet", a: "address", n: "limit" } });
        const { run } = await import("./commands/history.ts");
        return await run(args);
      }
      case "connections": {
        const args = mri<any>(rest,{ alias: { r: "revoke" } });
        const { run } = await import("./commands/connections.ts");
        return await run(args);
      }
      case "audit": {
        const args = mri<any>(rest,{ boolean: ["rejected", "json"], alias: { n: "limit", s: "source" } });
        const { run } = await import("./commands/audit.ts");
        return await run(args);
      }
      case "watch": {
        const { run } = await import("./commands/watch.ts");
        return await run();
      }
      case "send": {
        const args = mri<any>(rest, { string: ["wallet"], alias: { c: "chain", w: "wallet" } });
        const { run } = await import("./commands/send.ts");
        return await run(args._, args);
      }
      case "swap": {
        const args = mri(rest);
        const { run } = await import("./commands/swap.ts");
        return await run(args._);
      }
      case "install-shim": {
        const args = mri<any>(rest,{ boolean: ["force", "xdg"] });
        const { run } = await import("./commands/install-shim.ts");
        return await run(args);
      }
      case "proxy": {
        const args = mri<any>(rest, {
          string: ["domain"],
          boolean: ["no-pac", "install-launchd", "uninstall-launchd"],
          alias: { p: "port", d: "domain" },
        });
        const normalized = {
          port: args.port !== undefined ? Number(args.port) : undefined,
          domain: args.domain,
          noPac: args["no-pac"],
          installLaunchd: args["install-launchd"],
          uninstallLaunchd: args["uninstall-launchd"],
        };
        const { run } = await import("./commands/proxy.ts");
        return await run(normalized);
      }
      case "init": {
        const args = mri<any>(rest, {
          string: ["name", "import-key", "watch-only"],
          boolean: ["skip-shim", "skip-autostart", "skip-sanity"],
          alias: { n: "name" },
        });
        const normalized = {
          name: args.name,
          importKey: args["import-key"],
          watchOnly: args["watch-only"],
          skipShim: args["skip-shim"],
          skipAutostart: args["skip-autostart"],
          skipSanity: args["skip-sanity"],
          defaultChain: args["default-chain"] !== undefined ? Number(args["default-chain"]) : undefined,
          safeThreshold: args["safe-threshold"] !== undefined ? Number(args["safe-threshold"]) : undefined,
          daemonPort: args["daemon-port"] !== undefined ? Number(args["daemon-port"]) : undefined,
        };
        const { run } = await import("./commands/init.ts");
        return await run(normalized);
      }
      default: {
        console.error(`unknown subcommand: ${cmd}`);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`${COLOR.red}${(err as Error).message}${COLOR.reset}`);
    process.exit(1);
  }
}
