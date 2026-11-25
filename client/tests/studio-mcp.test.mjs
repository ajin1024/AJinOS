// Prevent new Studio data from missing its own service, or a project MCP from saving settings with the owner's authority.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import codex from "../../plugins/codex/agent.ts";
import { startStudio } from "../server.mjs";
import { businessProjects } from "../src/gateway-config.mjs";

async function mcp(home, mode, action) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "../studio-mcp.mjs"), mode, home], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const closed = once(child, "close");
  const lines = child.stdout[Symbol.asyncIterator]();
  let queued = "";
  let id = 0;
  const request = async (method, params) => {
    const requestId = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    while (!queued.includes("\n")) {
      const item = await lines.next();
      assert.equal(item.done, false, "MCP closed before responding");
      queued += item.value;
    }
    const newline = queued.indexOf("\n");
    const response = JSON.parse(queued.slice(0, newline));
    queued = queued.slice(newline + 1);
    assert.equal(response.id, requestId);
    return response;
  };
  try {
    assert.equal((await request("initialize", { protocolVersion: "2025-11-25" })).result.protocolVersion, "2025-11-25");
    return await action(
      async () => (await request("tools/list")).result.tools.map((tool) => tool.name),
      (name, args = {}) => request("tools/call", { name, arguments: args }),
    );
  } finally {
    child.stdin.end();
    await closed;
  }
}

const resultOf = (response) => {
  assert.equal(response.result?.isError, undefined, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
};

test("initialization registers only AJinOS as the default project with a scoped service", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-self-project-"));
  const studio = await startStudio({ home, port: 0, autostart: false });
  try {
    const config = JSON.parse(readFileSync(path.join(home, "studio.json"), "utf8"));
    assert.equal(config.defaultProject, "autoloop");
    assert.deepEqual(
      config.projects.map((item) => item.id),
      ["autoloop"],
    );
    assert.equal(existsSync(path.join(home, "workspaces", "orders")), false);
    assert.equal(existsSync(path.join(home, "workspaces", "content")), false);
    assert.equal(Object.hasOwn(config.rules.agents, "demo-analysis"), false);
    assert.equal(Object.hasOwn(config.rules.agents, "demo-review"), false);
    const project = config.projects.find((item) => item.id === config.defaultProject);
    assert.equal(project.name, "AJinOS");
    assert.equal(businessProjects(config)[0], project);
    assert.equal(project.service, "autoloop");
    assert.ok(existsSync(path.join(project.cwd, "README.md")));
    const rule = config.rules.rules.find((item) => item.name === project.rule);
    assert.equal(rule.cwd, project.cwd);
    assert.equal(config.rules.agents[rule.to].use, "codex");
    await mcp(home, "--project", async (list, call) => {
      assert.deepEqual(await list(), [
        "studio_overview",
        "configuration",
        "validate_configuration",
        "propose_configuration",
      ]);
      assert.equal(resultOf(await call("studio_overview")).defaultProject, "autoloop");
      assert.equal((await call("save_configuration", { revision: "anything", value: {} })).error.code, -32602);
    });
    const { readToken } = JSON.parse(readFileSync(path.join(home, "studio-mcp.json"), "utf8"));
    const configs = await fetch(studio.url + "/api/config", {
      method: "PUT",
      headers: { authorization: `Bearer ${readToken}`, "x-studio-action": "1" },
      body: "{}",
    });
    assert.equal(configs.status, 401);
    assert.equal(
      (
        await fetch(studio.url + "/api/config/draft/apply", {
          method: "POST",
          headers: { authorization: `Bearer ${readToken}`, "x-studio-action": "1" },
          body: "{}",
        })
      ).status,
      401,
    );
  } finally {
    await studio.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex receives the MCP registration only for the configured project directory", () => {
  const cwd = path.resolve("workspace with spaces", "autoloop");
  const args = [path.resolve("Program Files", "Autoloop Studio", "studio-mcp.mjs"), "--project", cwd];
  const turn = { cwd, contextFile: "", access: "read", prompt: "配置 Studio", program: "codex" };
  const env = "AGENT_AUTOLOOP_CODEX_MCP";
  const previous = process.env[env];
  process.env[env] = JSON.stringify({ cwd, args, name: "autoloop_studio", command: process.execPath });
  try {
    const ready = codex.command(turn);
    assert.ok(
      ready.includes(
        `mcp_servers.autoloop_studio={command=${JSON.stringify(process.execPath)},args=${JSON.stringify(args)}}`,
      ),
    );
    assert.ok(!codex.command({ ...turn, cwd: path.dirname(cwd) }).some((arg) => arg.includes("autoloop_studio")));
  } finally {
    if (previous === undefined) delete process.env[env];
    else process.env[env] = previous;
  }
});

test("a project proposal takes effect only after explicit approval from Studio", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-config-proposal-"));
  const studio = await startStudio({ home, port: 0, autostart: false });
  try {
    const draft = await mcp(home, "--project", async (list, call) => {
      const { revision, value } = resultOf(await call("configuration"));
      value.runtime.capacity = 3;
      const draft = resultOf(await call("propose_configuration", { revision, value, summary: "增加一个运行名额" }));
      assert.equal(resultOf(await call("configuration")).revision, revision);
      assert.equal(
        resultOf(await call("propose_configuration", { revision, value, summary: "增加一个运行名额" })).id,
        draft.id,
      );
      return draft;
    });
    const cookie = (await fetch(studio.url + "/")).headers.get("set-cookie").split(";")[0];
    const headers = { cookie, "x-studio-action": "1", "content-type": "application/json" };
    const preview = await (await fetch(studio.url + "/api/config/draft", { headers })).json();
    assert.deepEqual(preview.changes, [{ field: "runtime.capacity", before: 2, after: 3 }]);
    const applied = await fetch(studio.url + "/api/config/draft/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: draft.id }),
    });
    assert.equal(applied.status, 200);
    const saved = await applied.json();
    assert.equal(saved.value.runtime.capacity, 3);
    assert.equal(saved.restartRequired, true);
    assert.equal(await (await fetch(studio.url + "/api/config/draft", { headers })).json(), null);
  } finally {
    await studio.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("owner MCP validates and saves the same revision seen in Studio", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "studio-owner-mcp-"));
  const studio = await startStudio({ home, port: 0, autostart: false });
  try {
    await mcp(home, "--owner", async (list, call) => {
      assert.deepEqual(await list(), [
        "studio_overview",
        "configuration",
        "validate_configuration",
        "save_configuration",
      ]);
      const { revision, value } = resultOf(await call("configuration"));
      assert.equal(Object.hasOwn(value, "owner"), false);
      value.runtime.autoAcceptMinutes = -1;
      assert.equal((await call("validate_configuration", { value })).result.isError, true);
      assert.equal(resultOf(await call("configuration")).revision, revision);
      value.runtime.autoAcceptMinutes = 25;
      assert.equal(resultOf(await call("validate_configuration", { value })).ok, true);
      const updated = resultOf(await call("save_configuration", { revision, value }));
      assert.notEqual(updated.revision, revision);
      assert.equal(updated.value.runtime.autoAcceptMinutes, 25);
      assert.equal((await call("save_configuration", { revision, value })).result.isError, true);

      const cookie = (await fetch(studio.url + "/")).headers.get("set-cookie").split(";")[0];
      const web = await fetch(studio.url + "/api/config", { headers: { cookie } });
      assert.equal((await web.json()).revision, updated.revision);
    });
  } finally {
    await studio.close();
    rmSync(home, { recursive: true, force: true });
  }
});
