import React, { useEffect, useState } from "react";
import { Banner, Button, Tag, TextArea } from "@douyinfe/semi-ui";

const PLAN_STATUS_LABELS = { draft: "待确认草案", running: "协作执行中", completed: "已完成", cancelled: "已取消" };
const PLAN_STATUS_COLORS = { draft: "amber", running: "green", completed: "blue", cancelled: "grey" };
const STEP_STATUS_LABELS = {
  pending: "等待前置",
  dispatched: "执行中",
  done: "已完成",
  failed: "失败/停止",
  cancelled: "已取消",
};
const STEP_STATUS_COLORS = { pending: "grey", dispatched: "cyan", done: "green", failed: "red", cancelled: "grey" };

export function ChiefPanel({ api, toast, connected }) {
  const [brief, setBrief] = useState(null);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("ask"); // ask | plan
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [busyPlanId, setBusyPlanId] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [b, p] = await Promise.all([api("/chief/brief"), api("/chief/plans")]);
      setBrief(b);
      setPlans(p.plans || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting || !input.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      if (mode === "ask") {
        const res = await api("/chief/ask", "POST", { question: input.trim() });
        setAnswer(res);
      } else {
        const res = await api("/chief/plans", "POST", { goal: input.trim() });
        toast?.(`已生成协作计划草案「${res.plan.title}」，请核对步骤后确认启动`);
        setInput("");
        await load();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function actPlan(id, action) {
    setBusyPlanId(id);
    setError("");
    try {
      await api(`/chief/plans/${id}/${action}`, "POST", {});
      toast?.(action === "start" ? "协作计划已启动，将按依赖自动推进" : "计划已取消");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyPlanId("");
    }
  }

  const c = brief?.counts || {};

  return (
    <div className="sc-container" style={{ maxWidth: 1080, margin: "0 auto", padding: "8px 0 24px" }}>
      {error && <Banner type="danger" description={error} closeIcon={null} style={{ marginBottom: 12 }} />}

      <section className="sc-card" style={{ marginBottom: 14 }}>
        <div className="sc-card-head">
          <h2>全局实时简报（零消耗）</h2>
          <Button size="small" onClick={load} loading={loading}>
            刷新
          </Button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
          {[
            ["待你拍板", c.openQuestions ?? 0],
            ["待你验收", c.awaitingAcceptance ?? 0],
            ["执行中", c.running ?? 0],
            ["受阻/停止", c.blocked ?? 0],
            ["协作计划", c.activePlans ?? 0],
            ["记忆草案", c.memoryDrafts ?? 0],
          ].map(([label, val]) => (
            <div
              key={label}
              style={{
                border: "1px solid var(--semi-color-border)",
                borderRadius: 10,
                padding: "10px 12px",
                display: "grid",
                gap: 2,
              }}
            >
              <span className="sc-muted" style={{ fontSize: 12 }}>
                {label}
              </span>
              <strong style={{ fontSize: 22 }}>{val}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="sc-card" style={{ marginBottom: 14 }}>
        <div className="sc-card-head">
          <h2>总管指令台</h2>
          <div style={{ display: "flex", gap: 6 }}>
            <Button size="small" theme={mode === "ask" ? "solid" : "light"} onClick={() => setMode("ask")}>
              问全局进度（不派单）
            </Button>
            <Button size="small" theme={mode === "plan" ? "solid" : "light"} onClick={() => setMode("plan")}>
              拆解复合目标（多工单计划）
            </Button>
          </div>
        </div>
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 10 }}>
          <TextArea
            rows={3}
            value={input}
            onChange={setInput}
            placeholder={
              mode === "ask"
                ? "例如：现在手头哪几个任务卡住了？今天最需要我拍板的是哪两件事？"
                : "例如：先在订单项目里核对超时逻辑，完成后同步更新内容项目里的对外说明文档"
            }
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span className="sc-muted" style={{ fontSize: 12 }}>
              {mode === "ask"
                ? "总管只基于当前真实状态作答，不会触发任何后厨任务。"
                : "先生成待确认的多步依赖计划草案，你确认启动后才按顺序自动派发给对应项目。"}
            </span>
            <Button theme="solid" htmlType="submit" loading={submitting} disabled={!input.trim()}>
              {mode === "ask" ? "询问总管" : "生成协作计划草案"}
            </Button>
          </div>
        </form>
        {answer && (
          <div
            style={{
              marginTop: 12,
              border: "1px solid var(--semi-color-border)",
              borderRadius: 10,
              padding: "12px 14px",
              display: "grid",
              gap: 8,
            }}
          >
            <strong>总管答复</strong>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{answer.answer}</p>
            {answer.highlights?.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {answer.highlights.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="sc-card">
        <div className="sc-card-head">
          <h2>多工单协作计划（{plans.length}）</h2>
        </div>
        {!plans.length ? (
          <p className="sc-muted">暂无协作计划。上方切换到「拆解复合目标」即可创建跨项目多步任务计划。</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {plans.map((plan) => (
              <article
                key={plan.id}
                style={{
                  border: "1px solid var(--semi-color-border)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong>{plan.title}</strong>
                    <Tag size="small" color={PLAN_STATUS_COLORS[plan.status] || "grey"}>
                      {PLAN_STATUS_LABELS[plan.status] || plan.status}
                    </Tag>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {plan.status === "draft" && (
                      <Button
                        size="small"
                        theme="solid"
                        disabled={!connected}
                        loading={busyPlanId === plan.id}
                        onClick={() => actPlan(plan.id, "start")}
                      >
                        确认启动
                      </Button>
                    )}
                    {["draft", "running"].includes(plan.status) && (
                      <Button
                        size="small"
                        type="danger"
                        loading={busyPlanId === plan.id}
                        onClick={() => actPlan(plan.id, "cancel")}
                      >
                        取消计划
                      </Button>
                    )}
                  </div>
                </div>
                <p className="sc-muted" style={{ margin: 0, fontSize: 12.5 }}>
                  目标：{plan.goal}
                </p>
                <div style={{ display: "grid", gap: 6 }}>
                  {(plan.steps || []).map((step) => (
                    <div
                      key={step.id}
                      style={{
                        border: "1px dashed var(--semi-color-border)",
                        borderRadius: 8,
                        padding: "8px 10px",
                        display: "grid",
                        gap: 4,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <strong>
                          [{step.id}] {step.title}
                        </strong>
                        <Tag size="small" color={STEP_STATUS_COLORS[step.status] || "grey"}>
                          {STEP_STATUS_LABELS[step.status] || step.status}
                        </Tag>
                        <Tag size="small" type="ghost">
                          {step.projectName || step.project}
                        </Tag>
                        {step.dependsOn?.length > 0 && (
                          <span className="sc-muted" style={{ fontSize: 12 }}>
                            依赖：{step.dependsOn.join(", ")}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: 0, fontSize: 12.5 }}>{step.instruction}</p>
                      {step.summary && (
                        <p className="sc-muted" style={{ margin: 0, fontSize: 12 }}>
                          产出摘要：{step.summary}
                        </p>
                      )}
                      {step.error && (
                        <p style={{ margin: 0, fontSize: 12, color: "var(--semi-color-danger)" }}>异常：{step.error}</p>
                      )}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
