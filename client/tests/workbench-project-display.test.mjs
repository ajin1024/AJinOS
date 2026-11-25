// Prevent the selected task's project from appearing as an unexplained or missing tag.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

test("task path identifies the project for each selected task, including unassigned tasks", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/workbench.js", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    loader: { ".css": "text", ".png": "dataurl" },
  });
  const { Workbench } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
  );
  const tasks = [
    { id: 1, title: "长任务标题", project: "one", projectName: "内容工坊", status: "执行中", state: "claimed", path: [] },
    { id: 2, title: "另一任务", project: null, projectName: "其他规则", status: "排队中", state: "queued", path: [] },
  ];
  const view = { model: { running: [tasks[0]], queued: [tasks[1]], unknown: [], finished: [] }, task: () => tasks[0] };
  let html = Workbench.prototype.traceHTML.call(view);
  assert.match(html, /所属项目[\s\S]*内容工坊/);
  assert.match(html, /#2[\s\S]*未归属项目/);
  view.task = () => tasks[1];
  html = Workbench.prototype.traceHTML.call(view);
  assert.match(html, /所属项目[\s\S]*未归属项目/);
});
