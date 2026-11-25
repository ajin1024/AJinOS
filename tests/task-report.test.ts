// Prevent successful process exits, contradictory completion claims and lost receipt repairs from closing business work.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseResult } from "../protocol/validate.ts";
import { checkSchema } from "../protocol/schema.ts";
import type { TaskReport, TaskStep } from "../protocol/task-status.ts";
import { flowProblem, readMessage, resultFrom } from "../worker/contract.ts";

const complete: TaskReport = {
  state: "completed",
  goal: "定位并修复时长围栏问题",
  checks: [{ criterion: "成片满足已保存的围栏", verdict: "passed", evidence: "任务快照及成片时长已核对" }],
  remaining: [],
};
test("a completion report survives validation and worker receipt parsing", () => {
  const result = { outcome: "done", task: complete };
  assert.deepEqual(parseResult(result), result);
  assert.deepEqual(checkSchema("result", result), []);
  const parsed = resultFrom(
    readMessage(`已核实\n\`\`\`agent-autoloop\n${JSON.stringify({ task: complete })}\n\`\`\``),
    {},
  );
  assert.equal(parsed.problem, undefined);
  assert.deepEqual((parsed.result as any).task, complete);
});
test("claimed completion requires passing evidence and no remaining work", () => {
  for (const task of [
    { ...complete, checks: [] },
    { ...complete, checks: [{ ...complete.checks[0], verdict: "unverified" }] },
    { ...complete, checks: [{ ...complete.checks[0], evidence: " " }] },
    { ...complete, remaining: ["根因尚未确认"] },
  ])
    assert.throws(() => parseResult({ outcome: "done", task }), /task/);
});
test("unfinished reports preserve the remaining work and next step without claiming a process failure", () => {
  const task = {
    ...complete,
    state: "blocked",
    checks: [],
    remaining: ["核对任务快照"],
    nextStep: "取得项目入口后继续核对",
  };
  assert.deepEqual((parseResult({ outcome: "done", task }) as any).task, task);
  assert.throws(() => parseResult({ outcome: "done", task: { ...task, nextStep: "" } }), /task/);
  assert.deepEqual(parseResult({ outcome: "done", summary: "旧插件结果" }), { outcome: "done", summary: "旧插件结果" });
});
test("step reports survive validation, keep names unique and cannot claim completion while unpassed", () => {
  const steps = [{ name: "受理", verdict: "passed", evidence: "问清了范围" }];
  assert.deepEqual(parseResult({ outcome: "done", task: { ...complete, steps } }), {
    outcome: "done",
    task: { ...complete, steps },
  });
  assert.deepEqual(checkSchema("result", { outcome: "done", task: { ...complete, steps } }), []);
  assert.doesNotThrow(() =>
    parseResult({ outcome: "done", task: { ...complete, steps: [{ ...steps[0], verdict: "unverified" }] } }),
  );
  for (const bad of [
    { steps: [{ ...steps[0], name: " " }] },
    { steps: [steps[0], steps[0]] },
    { steps: [{ ...steps[0], verdict: "maybe" }] },
    { steps: [{ ...steps[0], other: true }] },
  ])
    assert.throws(() => parseResult({ outcome: "done", task: { ...complete, ...bad } }), /task/);
});

test("a completion claim missing a required flow step asks for the receipt to be rewritten, not the work", () => {
  const job = {
    rule: {
      flow: [
        { name: "受理", required: true },
        { name: "验证", required: false },
      ],
    },
  } as any;
  const passed: TaskStep[] = [{ name: "受理", verdict: "passed", evidence: "问清了范围" }];
  assert.match(flowProblem(job, { outcome: "done", task: complete })!, /受理/);
  assert.equal(flowProblem(job, { outcome: "done", task: { ...complete, steps: passed } }), undefined);
  assert.equal(
    flowProblem({ ...job, ticket: { steps: passed } }, { outcome: "done", task: complete }),
    undefined,
    "a step passed in an earlier round counts",
  );
  assert.equal(flowProblem(job, { outcome: "failed", error: "没跑成" }), undefined);
});

test("a missing report requests receipt-only repair and unsupported hubs retain the legacy result", () => {
  const message = readMessage("截图已核对，根因未确认");
  const missing = resultFrom(message, {}, true);
  assert.equal(missing.result.outcome, "done");
  assert.match(missing.problem!, /缺少 task/);
  const withTask = readMessage(`已核实\n\`\`\`agent-autoloop\n${JSON.stringify({ task: complete })}\n\`\`\``);
  assert.equal(resultFrom(withTask, {}, false, false).result.task, undefined);
});
