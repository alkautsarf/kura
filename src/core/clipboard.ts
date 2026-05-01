import { spawn } from "bun";

export function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn({ cmd: ["pbcopy"], stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      p.stdin.write(text);
      p.stdin.end();
      p.exited.then((code) => resolve(code === 0)).catch(() => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
