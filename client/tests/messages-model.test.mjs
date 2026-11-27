// Prevent the message center from losing messages, intakes or open cards, from hiding work that needs the user,
// and from firing a desktop notification on every refresh instead of only when something new needs attention.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConversations,
  buildMainEntries,
  buildThreadItems,
  isOutboxSettled,
  outboxProgressLabel,
  filterConversations,
  countActionableConversations,
  diffDesktopNotifications,
  buildMessageInbox,
} from "../src/messages/messages-model.mjs";

test("Inbox counts each approval, ticket and unresolved intake once across sources", () => {
  const card = { id: 7, state: "open", kind: "ask" };
  const intake = { id: "a", state: "needsProject" };
  const receipts = [
    { ticket: { id: 3 }, runs: [{ id: 8 }], workflow: { status: "awaiting_acceptance" } },
    { ticket: { id: 3 }, runs: [{ id: 9 }], workflow: { status: "awaiting_acceptance" } },
  ];
  const inbox = buildMessageInbox({
    cards: [card, { id: 9, state: "open", kind: "tell" }],
    conversations: [{ topic: "original", openCards: [card] }],
    intakes: [intake, intake, { id: "b", state: "routed" }],
    receipts,
  });
  assert.equal(inbox.total, 3);
  assert.equal(inbox.approvals[0].conversation.topic, "original");
  assert.equal(inbox.reviews.length, 1);
  assert.deepEqual(inbox.intakes, [intake]);
});

const CONFIG = {
  projects: [
    { id: "orders", name: "订单系统", rule: "orders", role: "project" },
    { id: "crm", name: "客户系统", rule: "crm", role: "project" },
    { id: "integration", name: "消息接入", rule: "integration", role: "integration" },
  ],
};

const TOPIC = { id: "topic-1", project: "orders", title: "批量发货", at: "2026-11-24T09:00:00.000Z" };
const MESSAGES = [
  {
    id: "m1",
    project: "orders",
    topic: "topic-1",
    text: "把发货按钮改成批量发货",
    at: "2026-11-24T09:00:00.000Z",
    attachments: [{ id: "att-1", url: "/api/attachments/att-1", filename: "a.png", mime: "image/png", size: 12 }],
  },
  { id: "m2", project: "orders", topic: "topic-1", text: "再加一个导出", at: "2026-11-24T10:00:00.000Z" },
];
const RUNS = [
  {
    id: 1,
    rule: "orders",
    agent: "codex",
    lane: "lane-1",
    state: "claimed",
    createdAt: "2026-11-24T09:10:00.000Z",
    summary: "正在批量改",
    events: [{ source: "local", subject: "orders:topic-1", summary: "批量发货" }],
  },
  {
    id: 2,
    rule: "crm",
    agent: "codex",
    lane: "lane-2",
    state: "queued",
    createdAt: "2026-11-24T08:00:00.000Z",
    events: [{ source: "local", subject: "crm:topic-2", summary: "整理客户" }],
  },
  {
    id: 3,
    rule: "orders",
    agent: "codex",
    lane: "lane-1",
    state: "done",
    createdAt: "2026-11-24T07:00:00.000Z",
    events: [{ source: "schedule", subject: "orders", summary: "定时巡检" }],
  },
];
const CARDS = [
  {
    id: 7,
    kind: "ask",
    state: "open",
    title: "导出格式选哪个？",
    text: "CSV 还是 Excel",
    rule: "orders",
    lane: "lane-1",
    createdAt: "2026-11-24T09:30:00.000Z",
  },
];

test("buildConversations merges topics, their messages, local runs and open cards into one timeline", () => {
  const list = buildConversations({
    config: CONFIG,
    messages: MESSAGES,
    topics: [TOPIC],
    runs: RUNS,
    cards: CARDS,
  });

  assert.equal(list.length, 2);
  const topic = list.find((item) => item.id === "topic-1");
  assert.equal(list[0].id, "topic-1");
  assert.equal(topic.kind, "topic");
  assert.equal(topic.topic, "topic-1");
  assert.equal(topic.title, "批量发货");
  assert.equal(topic.project, "orders");
  assert.equal(topic.projectName, "订单系统");
  assert.equal(topic.status, "needs_decision");
  assert.equal(topic.statusLabel, "待你决定");
  assert.equal(topic.actionable, true);
  assert.equal(topic.latestRun.id, 1);
  assert.deepEqual(topic.openCards.map((card) => card.id), [7]);
  assert.equal(topic.workflow.status, "running");
  assert.deepEqual(
    topic.items.map((item) => item.type),
    ["user_message", "run", "card", "user_message"],
  );
  assert.equal(topic.items[0].message.attachments[0].id, "att-1");
  assert.equal(topic.preview, "再加一个导出");

  const runOnly = list.find((item) => item.id === "topic-2");
  assert.equal(runOnly.kind, "topic");
  assert.equal(runOnly.project, "crm");
  assert.equal(runOnly.projectName, "客户系统");
  assert.equal(runOnly.status, "running");
  assert.equal(runOnly.actionable, false);
  assert.equal(runOnly.preview, "整理客户");
  assert.deepEqual(runOnly.items.map((item) => item.type), ["run"]);
  assert.equal(runOnly.title, "未命名话题");
});

test("a topic recorded before its first run is idle instead of pretending it awaits acceptance", () => {
  const [conversation] = buildConversations({
    config: CONFIG,
    topics: [{ id: "topic-0", project: "orders", title: "准备开工", at: "2026-11-24T08:00:00.000Z" }],
    messages: [
      { id: "m0", project: "orders", topic: "topic-0", text: "准备开工", at: "2026-11-24T08:00:00.000Z" },
    ],
  });

  assert.equal(conversation.status, "idle");
  assert.equal(conversation.statusLabel, "待开始");
  assert.equal(conversation.actionable, false);
  assert.equal(conversation.latestRun, null);
  assert.equal(conversation.preview, "准备开工");
  assert.deepEqual(conversation.items.map((item) => item.type), ["user_message"]);
});

test("buildConversations keeps unresolved intakes out of the routed list and maps their states to user actions", () => {
  const list = buildConversations({
    config: CONFIG,
    intakes: [
      {
        id: "intake-a",
        state: "needsConfirmation",
        input: { project: "orders", topic: "new", text: "帮我做周报", attachments: [{ id: "att-1" }] },
        text: "帮我做周报",
        reason: "需要确认统计口径",
        candidates: [],
        at: "2026-11-24T11:00:00.000Z",
      },
      {
        id: "intake-b",
        state: "needsProject",
        input: { project: "", topic: "new", text: "改一下首页" },
        text: "改一下首页",
        reason: "不确定属于哪个项目",
        candidates: ["orders", "crm"],
        at: "2026-11-24T12:00:00.000Z",
      },
      { id: "intake-c", state: "routed", input: {}, text: "已经派出去", at: "2026-11-24T13:00:00.000Z" },
      { id: "intake-d", state: "dismissed", input: {}, text: "不用管", at: "2026-11-24T14:00:00.000Z" },
    ],
  });

  assert.deepEqual(list.map((item) => item.id), ["intake:intake-b", "intake:intake-a"]);
  const needsProject = list[0];
  assert.equal(needsProject.kind, "intake");
  assert.equal(needsProject.status, "needs_project");
  assert.equal(needsProject.statusLabel, "待选择项目");
  assert.equal(needsProject.actionable, true);
  assert.equal(needsProject.workflow.status, "awaiting_project");
  assert.equal(needsProject.items[0].type, "intake_status");
  assert.equal(needsProject.intake.id, "intake-b");

  const needsConfirmation = list[1];
  assert.equal(needsConfirmation.status, "needs_confirmation");
  assert.equal(needsConfirmation.statusLabel, "待确认需求");
  assert.equal(needsConfirmation.intake.input.attachments[0].id, "att-1");
});

test("buildConversations folds a topic-linked intake into that conversation and keeps orphan open cards separate", () => {
  const list = buildConversations({
    config: CONFIG,
    topics: [{ id: "topic-3", project: "orders", title: "批量发货校验", at: "2026-11-24T13:00:00.000Z" }],
    messages: [
      { id: "m3", project: "orders", topic: "topic-3", text: "加一层校验", at: "2026-11-24T13:00:00.000Z" },
    ],
    runs: [
      {
        id: 4,
        rule: "orders",
        agent: "codex",
        lane: "lane-9",
        state: "done",
        createdAt: "2026-11-24T12:00:00.000Z",
        events: [{ source: "local", subject: "orders:topic-3", summary: "校验" }],
      },
    ],
    intakes: [
      {
        id: "intake-e",
        state: "needsProject",
        input: { project: "orders", topic: "topic-3", text: "给批量发货加校验" },
        text: "给批量发货加校验",
        reason: "请选择项目",
        at: "2026-11-24T13:00:00.000Z",
      },
    ],
    cards: [
      {
        id: 9,
        kind: "notify",
        state: "open",
        title: "部署完成",
        text: "版本已上线",
        rule: "crm",
        lane: "lane-9",
        createdAt: "2026-11-24T13:30:00.000Z",
      },
      { id: 10, kind: "ask", state: "decided", title: "已处理", rule: "orders", lane: "lane-9" },
    ],
  });

  const topic = list.find((item) => item.id === "topic-3");
  assert.equal(topic.status, "needs_project");
  assert.equal(topic.intake.id, "intake-e");
  assert.deepEqual(topic.intakes.map((intake) => intake.id), ["intake-e"]);
  assert.deepEqual(
    topic.items.map((item) => item.type),
    ["run", "user_message", "intake_status"],
  );

  const card = list.find((item) => item.id === "card:9");
  assert.equal(card.kind, "card");
  assert.equal(card.status, "needs_decision");
  assert.equal(card.statusLabel, "待处理通知");
  assert.equal(card.actionable, true);
  assert.equal(card.items[0].card.id, 9);
  assert.deepEqual(card.openCards.map((item) => item.id), [9]);
});

test("filterConversations narrows by actionable/running/done and by keyword while countActionableConversations totals the badge", () => {
  const list = [
    {
      id: "a",
      title: "订单导出",
      projectName: "订单系统",
      preview: "导出 CSV",
      status: "needs_decision",
      actionable: true,
      items: [{ type: "user_message", message: { text: "导出 CSV" } }],
    },
    {
      id: "b",
      title: "客户同步",
      projectName: "客户系统",
      preview: "正在同步",
      status: "running",
      actionable: false,
      items: [],
    },
    { id: "c", title: "周报", projectName: "内部", preview: "已完成", status: "done", actionable: false, items: [] },
  ];

  assert.deepEqual(filterConversations(list, { filter: "actionable" }).map((item) => item.id), ["a"]);
  assert.deepEqual(filterConversations(list, { filter: "running" }).map((item) => item.id), ["b"]);
  assert.deepEqual(filterConversations(list, { filter: "done" }).map((item) => item.id), ["c"]);
  assert.deepEqual(filterConversations(list, { filter: "all" }).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(filterConversations(list, { filter: "all", search: "订单" }).map((item) => item.id), ["a"]);
  assert.deepEqual(filterConversations(list, { filter: "all", search: "csv" }).map((item) => item.id), ["a"]);
  assert.deepEqual(filterConversations(list, { filter: "running", search: "周报" }), []);
  assert.equal(countActionableConversations(list), 1);
});

test("diffDesktopNotifications stays quiet after the baseline and only reports newly arrived cards, intakes and decisions", () => {
  const base = (overrides = {}) => ({
    id: "topic-1",
    kind: "topic",
    title: "批量发货",
    status: "running",
    actionable: false,
    openCards: [],
    intakes: [],
    intake: null,
    ...overrides,
  });
  const card = { id: 7, kind: "ask", state: "open", title: "导出格式选哪个？", text: "CSV 还是 Excel" };

  assert.deepEqual(diffDesktopNotifications(null, [base()], {}), []);
  assert.deepEqual(diffDesktopNotifications([base()], [base()], {}), []);

  const withCard = [base({ status: "needs_decision", actionable: true, openCards: [card] })];
  const [notice] = diffDesktopNotifications([base()], withCard, { windowFocused: false });
  assert.equal(notice.key, "card:7");
  assert.equal(notice.title, "需要你的回答");
  assert.equal(notice.body, "导出格式选哪个？");
  assert.equal(notice.route, "messages/topic-1");
  assert.deepEqual(diffDesktopNotifications(withCard, withCard, {}), []);
  assert.deepEqual(
    diffDesktopNotifications([base()], withCard, {
      windowFocused: true,
      activeRoute: { view: "messages", topic: "topic-1" },
    }),
    [],
  );
  assert.equal(
    diffDesktopNotifications([base()], withCard, {
      windowFocused: true,
      activeRoute: { view: "messages", topic: "topic-2" },
    }).length,
    1,
  );

  const intakeBase = (state) => ({
    id: "intake:intake-a",
    kind: "intake",
    title: "帮我做报表",
    status: "running",
    actionable: false,
    openCards: [],
    intakes: [{ id: "intake-a", state, text: "帮我做报表", reason: "统计口径不清" }],
    intake: { id: "intake-a", state, text: "帮我做报表", reason: "统计口径不清" },
  });
  const confirming = [intakeBase("confirming")];
  const needsConfirmation = [
    base({
      id: "intake:intake-a",
      kind: "intake",
      title: "帮我做报表",
      status: "needs_confirmation",
      actionable: true,
      intakes: [{ id: "intake-a", state: "needsConfirmation", text: "帮我做报表", reason: "统计口径不清" }],
      intake: { id: "intake-a", state: "needsConfirmation", text: "帮我做报表", reason: "统计口径不清" },
    }),
  ];
  const [intakeNotice] = diffDesktopNotifications(confirming, needsConfirmation, {});
  assert.equal(intakeNotice.key, "intake:intake-a:needs_confirmation");
  assert.equal(intakeNotice.title, "需要确认需求");
  assert.equal(intakeNotice.body, "统计口径不清");
  assert.equal(intakeNotice.route, "messages/intake%3Aintake-a");
  assert.deepEqual(diffDesktopNotifications(needsConfirmation, needsConfirmation, {}), []);

  const [taskNotice] = diffDesktopNotifications(
    [base({ status: "running" })],
    [base({ status: "needs_acceptance", actionable: true, latestRun: { id: 1 } })],
    {},
  );
  assert.equal(taskNotice.key, "task:topic-1:needs_acceptance");
  assert.equal(taskNotice.title, "任务待验收");
  assert.equal(taskNotice.route, "messages/topic-1");
  assert.deepEqual(diffDesktopNotifications([], [base()], {}), []);
});

test("buildMainEntries shows optimistic outbox messages immediately and merges routing state without duplicating intakes", () => {
  const sending = {
    id: "msg-1",
    pane: null,
    text: "帮我检查订单状态",
    attachments: [{ id: "att-1", url: "/api/attachments/att-1", filename: "shot.png" }],
    payload: { id: "msg-1", text: "帮我检查订单状态", mode: "auto" },
    at: "2026-11-26T09:00:00.000Z",
    status: "sending",
    error: "",
    result: null,
  };
  const routingIntake = {
    id: "msg-1",
    state: "routing",
    text: "帮我检查订单状态",
    input: { text: "帮我检查订单状态", attachments: [{ id: "att-1", url: "/api/attachments/att-1", filename: "shot.png" }] },
    at: "2026-11-26T09:00:01.000Z",
  };
  const standaloneIntake = {
    id: "msg-2",
    state: "needsProject",
    text: "改一下首页文案",
    reason: "无法唯一确定项目",
    candidates: ["orders"],
    input: { text: "改一下首页文案" },
    at: "2026-11-26T08:50:00.000Z",
  };
  const topicIntake = {
    id: "msg-3",
    state: "routing",
    text: "继续处理",
    input: { topic: "topic-1", text: "继续处理" },
    at: "2026-11-26T08:55:00.000Z",
  };

  const entries = buildMainEntries({
    outbox: [sending],
    intakes: [routingIntake, standaloneIntake, topicIntake],
  });

  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.kind]),
    [
      ["intake:msg-2", "intake"],
      ["outbox:msg-1", "outbox"],
    ],
  );
  assert.equal(entries[1].intakeState, "routing");
  assert.equal(outboxProgressLabel(entries[1].entry, routingIntake), "正在分配项目…");
  assert.equal(entries[1].attachments[0].id, "att-1");
});

test("buildMainEntries and isOutboxSettled hand off cleanly once history, intake or receipt arrives", () => {
  const answerOutbox = {
    id: "ans-1",
    pane: null,
    text: "今日简报",
    attachments: [],
    payload: { id: "ans-1", text: "今日简报", mode: "auto" },
    at: "2026-11-26T09:00:00.000Z",
    status: "sent",
    result: { kind: "answer", id: "ans-1" },
  };
  const taskOutbox = {
    id: "task-1",
    pane: null,
    text: "修复导出",
    attachments: [],
    payload: { id: "task-1", text: "修复导出", project: "orders" },
    at: "2026-11-26T09:01:00.000Z",
    status: "sent",
    result: { kind: "task", topic: "topic-9", project: "orders" },
  };
  const failedOutbox = {
    id: "fail-1",
    pane: null,
    text: "测试失败重试",
    attachments: [{ id: "att-2", url: "/api/attachments/att-2", filename: "b.png" }],
    payload: { id: "fail-1", text: "测试失败重试", mode: "auto" },
    at: "2026-11-26T09:02:00.000Z",
    status: "failed",
    error: "测试连接暂时中断",
    result: null,
  };

  // Before receipt arrives, taskOutbox stays visible; answerOutbox is already in history so it dedupes away.
  const history = [{ id: "ans-1", kind: "answer", text: "今日简报", answer: "一切正常", at: "2026-11-26T09:00:01.000Z" }];
  const beforeReceipt = buildMainEntries({ history, outbox: [answerOutbox, taskOutbox, failedOutbox] });
  assert.deepEqual(
    beforeReceipt.map((entry) => [entry.key, entry.kind]),
    [
      ["history:ans-1", "answer"],
      ["outbox:task-1", "outbox"],
      ["outbox:fail-1", "outbox"],
    ],
  );
  assert.equal(isOutboxSettled(answerOutbox, { history }), true);
  assert.equal(isOutboxSettled(taskOutbox, { receipts: [] }), false);
  assert.equal(isOutboxSettled(failedOutbox, { intakes: [] }), false);

  // Once the receipt arrives for topic-9, taskOutbox hands off cleanly.
  const receipts = [{ key: "r-9", topic: "topic-9", updatedAt: "2026-11-26T09:01:02.000Z", runs: [{ id: 9 }] }];
  const afterReceipt = buildMainEntries({ history, receipts, outbox: [answerOutbox, taskOutbox, failedOutbox] });
  assert.deepEqual(
    afterReceipt.map((entry) => [entry.key, entry.kind]),
    [
      ["history:ans-1", "answer"],
      ["task:r-9", "task"],
      ["outbox:fail-1", "outbox"],
    ],
  );
  assert.equal(isOutboxSettled(taskOutbox, { receipts }), true);
});

test("buildThreadItems appends optimistic thread replies for that topic only and dedupes once stored", () => {
  const conversation = {
    id: "topic-1",
    kind: "topic",
    topic: "topic-1",
    items: [{ type: "user_message", key: "message:m1", at: "2026-11-26T09:00:00.000Z", message: { id: "m1", text: "首条" } }],
  };
  const outbox = [
    { id: "m1", pane: "topic-1", text: "首条", at: "2026-11-26T09:00:00.000Z", status: "sent" },
    { id: "m2", pane: "topic-1", text: "补充说明", at: "2026-11-26T09:01:00.000Z", status: "sending" },
    { id: "m3", pane: "topic-other", text: "别的话题", at: "2026-11-26T09:02:00.000Z", status: "sending" },
    { id: "m4", pane: null, text: "主对话消息", at: "2026-11-26T09:03:00.000Z", status: "sending" },
  ];

  const items = buildThreadItems(conversation, outbox);
  assert.deepEqual(
    items.map((item) => [item.type, item.key]),
    [
      ["user_message", "message:m1"],
      ["outbox", "outbox:m2"],
    ],
  );
  assert.equal(isOutboxSettled(outbox[0], { messages: [{ id: "m1" }] }), true);
  assert.equal(isOutboxSettled(outbox[1], { messages: [{ id: "m1" }] }), false);
});

test("discuss outbox entries show discussion progress label and settle cleanly once history arrives", () => {
  const sending = {
    id: "disc-1",
    pane: null,
    text: "先聊聊需求",
    attachments: [],
    payload: { id: "disc-1", text: "先聊聊需求", mode: "discuss" },
    at: "2026-11-26T09:05:00.000Z",
    status: "sending",
    result: null,
  };
  assert.equal(outboxProgressLabel(sending), "正在和总管沟通需求…");
  const sent = {
    ...sending,
    status: "sent",
    result: { kind: "discuss", id: "disc-1", discussionId: "d-1", reply: "好的，先看范围。" },
  };
  assert.equal(isOutboxSettled(sent, { history: [] }), false);
  const history = [
    { id: "disc-1", kind: "discuss", discussionId: "d-1", text: "先聊聊需求", reply: "好的，先看范围。", at: "2026-11-26T09:05:01.000Z" },
  ];
  assert.equal(isOutboxSettled(sent, { history }), true);
  const entries = buildMainEntries({ history, outbox: [sent] });
  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.kind]),
    [["history:disc-1", "discuss"]],
  );
});
