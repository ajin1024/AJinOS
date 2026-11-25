// Credentials stay in the engine's private home, never in the renderer or source tree.
import { writeFileSync } from "node:fs";
import path from "node:path";
const { addKey, db } = await import("../host/runtime.ts");
const home = process.env.AGENT_AUTOLOOP_HOME;
const port = Number(process.argv[2]);
const config = {
  url: `http://127.0.0.1:${port}`,
  hub: { listen: `127.0.0.1:${port}`, publicUrl: `http://127.0.0.1:${port}` },
  worker: { name: "studio-local", key: addKey("worker", "studio-local"), capacity: 2 },
  source: { name: "local", key: addKey("source", "local") },
  owner: addKey("owner", "studio"),
  channels: {},
};
writeFileSync(path.join(home, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
db.close();
