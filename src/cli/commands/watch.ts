import { client } from "../client.ts";
import { COLOR } from "../format.ts";

export async function run(): Promise<void> {
  const { base, secret } = await client();
  const resp = await fetch(`${base}/events?stream=1`, {
    headers: { "X-Kura-Key": secret },
    // Local mkcert-signed cert: skip Bun's default CA bundle check
    tls: { rejectUnauthorized: false },
  } as RequestInit & { tls?: { rejectUnauthorized: boolean } });
  if (!resp.ok || !resp.body) {
    console.error(`watch failed: ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  console.log(`${COLOR.dim}streaming /events (Ctrl+C to stop)${COLOR.reset}`);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const lines = block.split("\n");
      const evtLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!evtLine || !dataLine) continue;
      const evt = evtLine.slice(7);
      console.log(`${COLOR.cyan}${evt}${COLOR.reset}  ${COLOR.dim}${dataLine.slice(6)}${COLOR.reset}`);
    }
  }
}
