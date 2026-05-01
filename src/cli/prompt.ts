import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";

function rl() {
  return createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const r = rl();
  const fmt = defaultValue !== undefined ? `${question} (${defaultValue}) ` : `${question} `;
  return new Promise((resolve) => {
    r.question(fmt, (answer) => {
      r.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export async function askSecret(question: string): Promise<string> {
  const r = rl();
  const wasRaw = stdin.isRaw;
  return new Promise((resolve) => {
    process.stdout.write(`${question} `);
    let buf = "";
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      if (ch === "\r" || ch === "\n") {
        stdin.removeListener("data", onData);
        if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        process.stdout.write("\n");
        r.close();
        resolve(buf);
        return;
      }
      if (ch === "\x7f") {
        if (buf.length) buf = buf.slice(0, -1);
        return;
      }
      if (ch === "\x03") {
        process.exit(130);
      }
      buf += ch;
    };
    stdin.on("data", onData);
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const def = defaultYes ? "Y/n" : "y/N";
  const ans = (await ask(`${question} (${def})`)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans === "y" || ans === "yes";
}

export async function choose(question: string, options: { label: string; value: string }[]): Promise<string> {
  process.stdout.write(`${question}\n`);
  for (let i = 0; i < options.length; i++) {
    process.stdout.write(`  ${i + 1}) ${options[i]!.label}\n`);
  }
  const ans = await ask(`select 1-${options.length}:`, "1");
  const idx = Math.max(1, Math.min(options.length, parseInt(ans, 10) || 1)) - 1;
  return options[idx]!.value;
}

export async function readStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = "";
    stdin.on("data", (chunk) => (buf += chunk.toString()));
    stdin.on("end", () => resolve(buf.trim()));
  });
}
