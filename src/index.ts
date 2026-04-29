#!/usr/bin/env bun
// kura - wallet terminal entry point
// Routes by argv[0] subcommand to: tui (default), cli, daemon, popup, init, install-shim, audit, watch.

const VERSION = "0.1.2";

const args = process.argv.slice(2);
const subcommand = args[0];

async function main() {
  switch (subcommand) {
    case undefined:
      // No args: open the TUI (or onboard if no config exists).
      const { run: runTui } = await import("./tui/index.tsx");
      return runTui();

    case "daemon": {
      const { run: runDaemon } = await import("./daemon/index.ts");
      return runDaemon();
    }

    case "popup": {
      const { run: runPopup } = await import("./popup/index.tsx");
      return runPopup(args.slice(1));
    }

    case "init":
    case "install-shim":
    case "send":
    case "swap":
    case "balance":
    case "history":
    case "connections":
    case "audit":
    case "watch":
    case "proxy": {
      const { run: runCli } = await import("./cli/index.ts");
      return runCli(args);
    }

    case "--version":
    case "-v":
      console.log(`kura ${VERSION}`);
      return;

    case "--help":
    case "-h":
      console.log(`kura ${VERSION} - wallet terminal

Usage:
  kura                       open the portfolio TUI
  kura init                  run first-time setup wizard
  kura send <amt> <tok> <to> send tokens
  kura swap <in> <out>       swap tokens
  kura balance               show balances
  kura history               show recent activity
  kura connections           list dapp connections
  kura audit                 inspect off-chain event log
  kura watch                 stream daemon SSE events
  kura install-shim          (re)install qutebrowser userscript
  kura daemon                run as background daemon
  kura proxy                 run csp-strip HTTPS proxy (also auto-started by daemon if enabled in config)
  kura popup <id>            render approval popup (spawned by daemon)
`);
      return;

    default:
      console.error(`unknown subcommand: ${subcommand}`);
      console.error(`run 'kura --help' for usage`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
