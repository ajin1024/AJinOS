// A real, deterministic child process used to verify the orchestration without calling a model or external service.
import { readFileSync } from "node:fs";
const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, "utf8"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) =>
  process.stderr.write(JSON.stringify({ type: "studio.progress", at: new Date().toISOString(), text }) + "\n");
const reply = (text, receipt) =>
  console.log(text + (receipt ? "\n\n```agent-autoloop\n" + JSON.stringify(receipt) + "\n```" : ""));
const report = (remaining = [], nextStep) => ({
  state: remaining.length ? "incomplete" : "completed",
  goal: "验证隔离演示任务的状态流转，不访问真实业务服务",
  checks: [
    { criterion: "本轮演示分支已执行并输出结果", verdict: "passed", evidence: "本地确定性演示执行器已运行到对应分支" },
  ],
  remaining,
  ...(remaining.length && { nextStep }),
});
log("读取当前话题的事件、决定与复查资料");
await pause(1200);
log("演示执行器正在核对输入；没有访问业务系统");
await pause(1400);
// Leave enough time to inspect the queue when explicitly running the harbor demo.
if (context.events.some((e) => e.detail?.includes("港口可视化演示"))) {
  log("正在执行港口任务流演示，可点击地图中的任务舱查看当前状态");
  await pause(6000);
}
if (context.events.some((e) => e.detail?.includes("模拟失败"))) {
  log("按演示输入返回临时失败");
  reply("没跑成：演示临时失败，中台将按退避策略重派");
} else if (context.timers.length) {
  log("完成到期复查，演示闭环已结束");
  reply("演示复查完成，等待验收", { task: report() });
} else if (context.answers.length) {
  log("读取用户决定：" + (context.answers[0].chosen || context.answers[0].text));
  await pause(1000);
  const proceed = context.answers[0].choice !== 1;
  reply(
    proceed ? "已按决定完成演示步骤，10 秒后复查" : "已按决定结束演示，不再复查",
    proceed
      ? {
          task: report(["到期复查尚未执行"], "10 秒后核实演示步骤"),
          later: [
            {
              key: "studio-review",
              at: new Date(Date.now() + 10000).toISOString(),
              about: "核实演示任务已闭环；不访问任何真实服务",
            },
          ],
        }
      : { task: report() },
  );
} else if (context.events.some((e) => e.detail?.includes("直接完成"))) {
  log("无需人工决定，直接完成");
  reply("演示步骤已完成，等待验收", { task: report() });
} else {
  log("分析已完成，生成需要用户决定的卡片");
  reply("演示分析完成，等待你选择下一步", {
    task: report(["尚待决定是否继续验证"], "答复后按选择继续或结束演示"),
    ask: [
      {
        title: "继续执行演示验证吗？",
        text: "这是隔离的演示任务，只验证状态流转，不修改项目或调用模型。",
        options: ["继续验证并复查", "结束演示"],
        recommend: 0,
        key: "studio-confirm",
        about: "演示分析已完成；按用户选择继续验证，再预约一次复查。",
      },
    ],
  });
}
