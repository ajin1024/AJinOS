import { useState } from "react";

export function useTaskVerification({ api, toast, connected, runId, status, verification }) {
  const [verifying, setVerifying] = useState(false);
  const [localReport, setLocalReport] = useState(null);
  const canVerify = Boolean(connected && api && runId && ["awaiting_acceptance", "reviewing"].includes(status));
  const activeVerify = localReport?.runId === runId ? localReport : verification;

  async function runAiVerify() {
    if (!canVerify || verifying) return;
    setVerifying(true);
    try {
      const { report } = await api(`/tasks/${runId}/verify`, "POST", {});
      if (report) setLocalReport(report);
      toast?.("AI 独立校验已完成，请结合校验意见验收");
    } catch (error) {
      toast?.(error.message || "AI 校验失败", true);
    } finally {
      setVerifying(false);
    }
  }

  return { activeVerify, canVerify, verifying, runAiVerify };
}
