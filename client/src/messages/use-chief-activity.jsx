import { useCallback, useEffect, useRef, useState } from "react";
import { PlanCard } from "./dialog-parts.jsx";
import React from "react";

export function useChiefActivity(api, toast) {
  const [data, setData] = useState({ plans: [], history: [], error: "" });
  const [busy, setBusy] = useState("");
  const request = useRef(0);
  const reload = useCallback(async () => {
    const current = ++request.current;
    const [plans, history] = await Promise.allSettled([api("/chief/plans"), api("/router/history")]);
    if (current !== request.current) return;
    setData((previous) => ({
      plans: plans.status === "fulfilled" ? plans.value.plans : previous.plans,
      history: history.status === "fulfilled" ? history.value.history : previous.history,
      usage: history.status === "fulfilled" ? history.value.usage : previous.usage,
      error: [plans, history].find((result) => result.status === "rejected")?.reason.message || "",
    }));
  }, [api]);
  useEffect(() => {
    let timer;
    let stopped = false;
    async function poll() {
      await reload();
      if (!stopped) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      request.current++;
    };
  }, [reload]);

  async function act(id, action) {
    setBusy(id);
    try {
      const { plan } = await api(`/chief/plans/${id}/${action}`, "POST", {});
      setData((previous) => ({ ...previous, plans: previous.plans.map((entry) => (entry.id === id ? plan : entry)) }));
      await reload();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy("");
    }
  }

  return { ...data, busy, act, reload };
}

export function PlanView({ chief, connected, onThread }) {
  const { plans, error, busy, act } = chief;
  return (
    <div className="studio-plan-view">
      {error && <p role="alert">{error}</p>}
      {!plans.length && !error && (
        <p className="secondary">协作计划会在这里显示。可以在对话中用 /plan 发起一份草案。</p>
      )}
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          connected={connected}
          busy={busy === plan.id}
          onAction={act}
          onThread={onThread}
        />
      ))}
    </div>
  );
}

export function ActivePlans({ plans, onOpen }) {
  const active = plans.filter((plan) => plan.status === "running");
  return (
    <section className="studio-active-plans" aria-label="活跃协作计划">
      <header>
        <h2>活跃协作计划</h2>
        <button type="button" onClick={onOpen}>
          查看计划 ›
        </button>
      </header>
      {!active.length && <p>暂无正在推进的协作计划</p>}
      {active.map((plan) => {
        const done = plan.steps.filter((step) => step.status === "done").length;
        return (
          <article key={plan.id}>
            <strong>{plan.title}</strong>
            <div>
              <progress aria-label={plan.title} max={plan.steps.length} value={done} />
              <small>
                {done}/{plan.steps.length}
              </small>
            </div>
          </article>
        );
      })}
    </section>
  );
}
