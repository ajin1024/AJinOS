const clean = (text) =>
  String(text || "")
    .replace(/```agent-autoloop[\s\S]*?(?:```|$)/g, "")
    .trim();
const live = new Set(["queued", "claimed", "unknown"]);

export function outputExcerpt(output) {
  return (output.entries || []).slice(-3)
    .map((entry) => clean(entry.text))
    .filter(Boolean)
    .join("\n")
    .slice(-1400);
}

export function conversationNoteFor(rounds) {
  return `${rounds.some((r) => !r.record || r.record.note?.includes("读取失败")) ? "部分轮次或过程读取失败。" : ""}${rounds.some((r) => r.record?.archiveIncomplete) ? "有已结束的轮次没有完整存档，当前显示仍可读取的记录。" : ""}按关联轮次展示已记录的需求和公开反馈；过程输出可能已截断或过期，未记录的步骤不会补造。`;
}

export function taskRecord(run, facts = [], output = {}, provider) {
  const eventIds = new Set(
    facts
      .flatMap((f) => f.changes || [])
      .filter((c) => c.table === "run_events" && Number(c.row?.run_id) === Number(run.id))
      .map((c) => Number(c.row.event_id)),
  );
  const events = new Map();
  for (const f of facts)
    for (const c of f.changes || [])
      if (c.table === "events" && c.row && eventIds.has(Number(c.row.id ?? c.key)))
        events.set(Number(c.row.id ?? c.key), c.row);
  const originals = events.size
    ? [...events.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e)
    : [...(run.events || [])].reverse();
  const inputs = originals.map((e) => ({
    type: e.type || "",
    summary: e.summary || "",
    detail: e.detail || "",
    source:
      e.sourceName || { schedule: "定时触发", local: "工作台消息", manual: "手动触发" }[e.source] || e.source || "",
    link: e.link || "",
  }));
  const feedback = [];
  const add = (text, entry) => {
    text = clean(text);
    if (text && ((output.pendingAttempts || []).includes(entry.attempt) || feedback.at(-1)?.text !== text))
      feedback.push({ text, attempt: entry.attempt });
  };
  for (const item of output.conversation || []) {
    const text = clean(item.text);
    if (text) feedback.push({ text, attempt: item.attempt });
  }
  const pending = new Map();
  for (const entry of output.entries || []) {
    if ((output.archivedAttempts || []).includes(entry.attempt)) continue;
    const before = feedback.length;
    if (provider === "command" && entry.file.startsWith("stdout")) {
      add(entry.text, entry);
      continue;
    }
    for (const line of (entry.text || "").split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type === "studio.progress") add(event.text, entry);
        if (event.type === "item.completed" && event.item?.type === "agent_message") add(event.item.text, entry);
        if (
          provider === "codex" &&
          event.type === "item.completed" &&
          ["command_execution", "file_change", "mcp_tool_call"].includes(event.item?.type)
        ) {
          if (
            event.item.status === "failed" ||
            (typeof event.item.exit_code === "number" && event.item.exit_code !== 0)
          )
            add("一项操作没有执行成功。", entry);
          else if (event.item.status === "completed") add("已完成一项操作。", entry);
        }
        if (event.type === "assistant")
          add(
            event.message?.content
              ?.filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
            entry,
          );
        if (provider === "claude" && event.type === "user" && Array.isArray(event.message?.content))
          for (const part of event.message.content)
            if (part?.type === "tool_result") add(part.is_error ? "一项操作没有执行成功。" : "已完成一项操作。", entry);
      } catch {
        /* An output tail may start in the middle of a JSON record. */
      }
    }
    if ((output.pendingAttempts || []).includes(entry.attempt)) {
      const fresh = feedback.splice(before);
      pending.set(entry.attempt, [...(pending.get(entry.attempt) || []), ...fresh]);
    }
  }
  for (const items of pending.values()) feedback.push(...items);
  const receipts = [],
    timeline = [],
    answers = new Map();
  for (const fact of facts)
    for (const change of fact.changes || []) {
      const row = change.row;
      if (!row) continue;
      if (change.table === "cards" && eventIds.has(Number(row.answer_event))) {
        let options = [];
        try {
          options = typeof row.options === "string" ? JSON.parse(row.options) : row.options || [];
        } catch {
          /* An unreadable option is not a recorded answer. */
        }
        const text = [Number.isInteger(row.choice) ? options[row.choice] : "", row.answer].filter(Boolean).join("\n");
        if (text) answers.set(row.id ?? change.key, text);
      }
      if (change.table === "cards" && Number(row.run_id ?? row.run) === Number(run.id)) {
        const receipt = { at: fact.at, kind: row.kind, title: row.title || "", text: row.text || "", state: row.state };
        if (!receipts.some((r) => r.kind === receipt.kind && r.title === receipt.title && r.text === receipt.text))
          receipts.push(receipt);
      }
      if (change.table === "runs" && Number(row.id ?? change.key) === Number(run.id)) {
        const item = { at: fact.at, state: row.state, summary: row.summary || row.error || "" };
        const last = timeline.at(-1);
        if (item.state && (!last || last.state !== item.state || last.summary !== item.summary)) timeline.push(item);
      }
    }
  const result = live.has(run.state) ? "" : run.summary || run.error || feedback.at(-1)?.text || "";
  const current =
    run.state === "queued"
      ? "等待执行器领取，尚未开始处理。"
      : run.state === "unknown"
        ? "执行状态暂时不明，正在等待执行器确认。"
        : run.state === "claimed"
          ? feedback.at(-1)?.text || "执行器已领取，尚未上报具体处理进展。"
          : result || "本轮已结束，但没有上报详细结果。";
  const links = [];
  const texts = [
    ...inputs.flatMap((i) => [i.link, i.detail]),
    result,
    ...feedback.map((f) => f.text),
    ...receipts.map((r) => r.text),
  ];
  for (const text of texts)
    for (const match of String(text || "").matchAll(/https?:\/\/[^\s<>"'\[\]()，。；！？]+/g)) {
      try {
        const url = new URL(match[0]).href;
        if (!links.includes(url)) links.push(url);
      } catch {
        /* Ignore malformed reported links. */
      }
    }
  return {
    title: inputs[0]?.summary || run.rule || `任务 #${run.id}`,
    inputs,
    current,
    result,
    feedback,
    receipts,
    answers: [...answers.values()],
    timeline,
    links,
    note: output.note || "",
    archiveIncomplete:
      !live.has(run.state) &&
      ((output.pendingAttempts || []).length > 0 ||
        (["codex", "claude"].includes(provider) &&
          Array.isArray(output.archivedAttempts) &&
          (output.archivedAttempts.length === 0 ||
            (output.entries || []).some((entry) => !output.archivedAttempts.includes(entry.attempt))))),
  };
}

export function taskConversation(rounds) {
  const messages = [];
  for (const { run, record } of rounds) {
    for (const input of record.inputs) {
      if (["card.answered", "timer.due"].includes(input.type)) continue;
      const text = input.detail || input.summary;
      if (text) messages.push({ role: "user", text, run: run.id });
    }
    for (const text of record.answers || []) messages.push({ role: "user", text, run: run.id });
    for (const item of record.feedback) messages.push({ role: "assistant", text: item.text, run: run.id });
    const firstLine = (text) =>
      String(text || "")
        .split("\n")[0]
        .replace(/\*\*/g, "")
        .trim();
    if (record.result && firstLine(record.feedback.at(-1)?.text) !== firstLine(record.result))
      messages.push({ role: "assistant", text: record.result, run: run.id });
    for (const receipt of record.receipts || []) {
      if (receipt.kind !== "ask") continue;
      const text = [receipt.title, receipt.text].filter(Boolean).join("\n");
      if (text) messages.push({ role: "assistant", text, run: run.id });
    }
  }
  return messages;
}
