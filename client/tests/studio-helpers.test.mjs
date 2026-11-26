// Prevent broken legacy bookmarks, invalid derived project IDs, or hidden derived rules from slipping into Studio navigation and forms.
import test from "node:test";
import assert from "node:assert/strict";
import { parseHashRoute, routeToHash, deriveProjectId, folderNameFromPath } from "../src/studio-helpers.mjs";

test("parseHashRoute maps canonical and legacy hashes cleanly", () => {
  for (const hash of ["", "#", "#overview", "#tasks/overview"])
    assert.deepEqual(parseHashRoute(hash), { view: "tasks", section: null, tasksTab: "overview" });
  assert.deepEqual(parseHashRoute("#overview"), { view: "tasks", section: null, tasksTab: "overview" });
  assert.deepEqual(parseHashRoute("#projects"), { view: "settings", section: "projects", tasksTab: "list" });
  assert.deepEqual(parseHashRoute("#projects/orders"), { view: "settings", section: "projects", tasksTab: "list", projectId: "orders" });
  assert.deepEqual(parseHashRoute("#inbox"), { view: "messages", section: "inbox", tasksTab: "list", topic: null });
  assert.deepEqual(parseHashRoute("#tasks?tab=todo"), { view: "tasks", section: null, tasksTab: "inbox" });
  assert.deepEqual(parseHashRoute("#settings"), { view: "settings", section: "projects", tasksTab: "list" });
  assert.deepEqual(parseHashRoute("#memory"), { view: "settings", section: "memory", tasksTab: "list" });
  assert.deepEqual(parseHashRoute("#settings/gateway"), { view: "settings", section: "gateway", tasksTab: "list" });
  assert.deepEqual(parseHashRoute("#rules"), { view: "settings", section: "rules", tasksTab: "list" });
  assert.deepEqual(parseHashRoute("#connections"), { view: "settings", section: "connections", tasksTab: "list" });
  assert.deepEqual(parseHashRoute("#agents"), { view: "settings", section: "agents", tasksTab: "list" });
  assert.deepEqual(parseHashRoute("#feishu-groups"), { view: "settings", section: "feishu", tasksTab: "list" });
  assert.deepEqual(parseHashRoute("#settings/nonexistent"), { view: "settings", section: "runtime", tasksTab: "list" });
  assert.deepEqual(parseHashRoute("#messages"), { view: "messages", section: null, tasksTab: "list", topic: null });
  assert.deepEqual(parseHashRoute("#messages/topic-1"), {
    view: "messages",
    section: null,
    tasksTab: "list",
    topic: "topic-1",
  });
  assert.deepEqual(parseHashRoute("#messages/intake%3Aabc"), {
    view: "messages",
    section: null,
    tasksTab: "list",
    topic: "intake:abc",
  });
  assert.equal(routeToHash({ view: "settings", section: "logs" }), "settings/logs");
  assert.equal(routeToHash({ view: "tasks", tasksTab: "inbox" }), "tasks?tab=todo");
  assert.equal(routeToHash({ view: "messages", section: "inbox" }), "inbox");
  assert.equal(routeToHash({ view: "tasks", tasksTab: "plans" }), "tasks/plans");
  assert.equal(routeToHash({ view: "tasks" }), "overview");
  assert.equal(routeToHash({ view: "tasks", tasksTab: "overview" }), "overview");
  assert.deepEqual(parseHashRoute("#tasks"), { view: "tasks", section: null, tasksTab: "list" });
  assert.equal(routeToHash({ view: "messages" }), "messages");
  assert.equal(routeToHash({ view: "messages", topic: "topic-1" }), "messages/topic-1");
  assert.equal(routeToHash({ view: "messages", topic: "intake:abc" }), "messages/intake%3Aabc");
  assert.equal(routeToHash({ view: "overview" }), "overview");
});

test("folderNameFromPath returns the folder name used to prefill a new project", () => {
  assert.equal(folderNameFromPath("C:/workspace/Billing-API"), "Billing-API");
  assert.equal(folderNameFromPath("D:\\code\\123-demo\\"), "123-demo");
  assert.equal(folderNameFromPath("D:\\中文路径"), "中文路径");
  assert.equal(folderNameFromPath("C:/"), "");
  assert.equal(folderNameFromPath(""), "");
});

test("deriveProjectId always generates valid unique protocol IDs", () => {
  assert.equal(deriveProjectId("My App", "C:/workspace/Billing-API", []), "billing-api");
  assert.equal(deriveProjectId("订单系统", "D:\\code\\123-demo", []), "demo");
  assert.equal(deriveProjectId("纯中文项目", "D:\\中文路径", []), "project");
  assert.equal(deriveProjectId("纯中文项目", "D:\\中文路径", ["project"]), "project-2");
  for (const id of [
    deriveProjectId("My App", "C:/workspace/Billing-API", []),
    deriveProjectId("纯中文项目", "D:\\中文路径", ["project", "project-2"]),
  ]) {
    assert.match(id, /^[a-z][a-z0-9-]{0,39}$/);
  }
});
