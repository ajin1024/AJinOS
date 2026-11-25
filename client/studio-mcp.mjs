import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serveMcp } from "../cli/mcp.ts";

export const discoveryName = "studio-mcp.json";
export const ownerProof = (key, token) => createHmac("sha256", key).update(token).digest("hex");

function startBridge(mode, home) {
  if (!["--project", "--owner"].includes(mode) || !home || !path.isAbsolute(home))
    throw new Error("请指定 --project 或 --owner，以及 Studio 数据目录的绝对路径。");
  const read = (name) => JSON.parse(readFileSync(path.join(home, name), "utf8"));
  const string = { type: "string", minLength: 1 };
  const object = { type: "object" };
  const tools = [
    ["studio_overview", "查看 Studio 引擎与配置概况", "GET", "/api/mcp/overview", {}, false],
    ["configuration", "读取工作空间配置和修订号", "GET", "/api/config", {}, false],
    ["validate_configuration", "预先校验完整工作空间配置", "POST", "/api/config/validate", { value: object }, false],
    mode === "--owner"
      ? [
          "save_configuration",
          "用已读取的修订号保存配置",
          "PUT",
          "/api/config",
          { revision: string, value: object },
          true,
        ]
      : [
          "propose_configuration",
          "提交配置建议，等待本人在桌面端审核应用",
          "POST",
          "/api/mcp/proposal",
          { revision: string, value: object, summary: string },
          true,
        ],
  ].map(([name, description, method, endpoint, properties, modifies]) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    annotations: { readOnlyHint: !modifies, destructiveHint: name === "save_configuration" },
    method,
    endpoint,
  }));
  // Route information is process-local. Clients may supply only the arguments declared on each tool.
  const routes = new Map(tools.map(({ name, method, endpoint }) => [name, { method, endpoint }]));
  serveMcp(
    "autoloop-studio",
    tools.map(({ method, endpoint, ...tool }) => tool),
    async (tool, args) => {
      let discovery;
      try {
        discovery = read(discoveryName);
      } catch {
        throw new Error("请先打开 AJinOS。");
      }
      const { url, readToken } = discovery;
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || !/^[a-f0-9]{64}$/.test(readToken))
        throw new Error("无法连接到本机 Studio。");
      const owner = mode === "--owner" ? read("config.json").owner : undefined;
      if (mode === "--owner" && !owner) throw new Error("这台电脑没有本人的管理密钥。");
      const { method, endpoint } = routes.get(tool.name);
      const token = owner ? ownerProof(owner, readToken) : readToken;
      const response = await fetch(url + endpoint, {
        method,
        headers: { authorization: `Bearer ${token}`, "x-studio-action": "1", "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(args),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Studio 请求失败。");
      return result;
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    startBridge(...process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
