# Prevent visible lifecycle controls from accepting unseen results or losing the original task during rework.
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import tempfile
from threading import Thread
from playwright.sync_api import sync_playwright, expect
expect.set_options(timeout=20000)

root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="studio-lifecycle-ui-") as temp:
    script = """
      import { startStudio } from './client/server.mjs';
      const studio = await startStudio({ home: process.argv[1], port: 0, autostart: true,
        gatewayModel: async (kind, data) => kind === 'confirm'
          ? data.text === '模糊任务' ? {confirmed:false,question:'希望交付什么结果？'} : {confirmed:true,reason:'明确要求检查并交付结果'}
          : {project:'orders',flow:'default',certain:true,reason:'测试任务',candidates:['orders']} });
      console.log(JSON.stringify({url:studio.url}));
      process.stdin.once('data', async () => { await studio.close(); process.exit(0); });
    """
    with (Path(temp) / "stderr.log").open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(["node", "--input-type=module", "-e", script, temp], cwd=root,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8",
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        ready = Queue()
        Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
        try:
            url = json.loads(ready.get(timeout=45))["url"]
            with sync_playwright() as p:
                browser = p.chromium.launch(channel="msedge", headless=True)
                try:
                    page = browser.new_page(viewport={"width": 1440, "height": 1000})
                    page.set_default_timeout(20000)
                    errors = []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    page.goto(url)
                    page.wait_for_selector(".fc-canvas")
                    page.locator("#new-task").click()
                    form = page.locator("#new-task-form")
                    form.locator('[name="project"]').select_option("orders")
                    form.locator('[name="text"]').fill("模糊任务")
                    page.locator("#dialog-submit").click()
                    expect(page.locator("#route-result")).to_contain_text("希望交付什么结果")
                    form.locator('[name="text"]').fill("核对测试结果并直接完成")
                    page.locator("#dialog-submit").click()
                    expect(form).not_to_be_visible()

                    def wait_rounds(count):
                        page.wait_for_function("""async (count) => {
                          const s = await (await fetch('/api/state')).json();
                          return s.state?.runs.length >= count && s.state.runs.every(r => r.state === 'done');
                        }""", arg=count, timeout=30000)

                    wait_rounds(1)
                    page.locator('[data-view="tasks"]').first.click()
                    page.locator("#task-scope-demo").click()
                    expect(page.locator('[data-board-col="acceptance"] .kb-card')).to_have_count(1)
                    page.locator("#task-view-list").click()
                    detail = page.get_by_role("region", name="任务详情")
                    expect(detail).to_contain_text("待验收")

                    def open_latest():
                        detail.get_by_role("tab", name="执行记录").click()
                        detail.locator(".task-round").last.get_by_role("button", name="结果与输出").click()
                        page.locator("#drawer").get_by_role("tab", name="执行记录").click()
                        expect(page.locator("#drawer .task-workflow")).to_be_visible()

                    detail.get_by_role("button", name="退回修改").click()
                    action_form = page.locator(".semi-modal-content form")
                    action_form.locator('[name="text"]').fill("修正位置并直接完成")
                    page.locator("#dialog-submit").click()
                    expect(action_form).not_to_be_visible()
                    wait_rounds(2)
                    expect(detail).to_contain_text("2 轮执行")
                    open_latest()
                    expect(page.locator("#drawer .task-workflow")).to_contain_text("返工")
                    expect(page.locator('#drawer [data-command="accept"]').first).to_be_visible()

                    # Advance the same task after the user has opened an older completed result.
                    snapshot = page.request.get(url + "/api/state").json()
                    topic = snapshot["topics"][0]["id"]
                    response = page.request.post(url + "/api/messages", headers={"x-studio-action":"1"},
                        data={"id":"ui-new-round", "conversation":topic, "text":"再次核对并直接完成"})
                    assert response.ok, response.text()
                    wait_rounds(3)
                    page.locator('#drawer [data-command="accept"]').first.click()
                    expect(page.locator("#drawer")).to_be_visible()
                    expect(page.locator("body")).to_contain_text("任务已更新，请查看最新结果后再操作")
                    state = page.request.get(url + "/api/state").json()
                    assert not any(w.get("mode") == "closed" for w in state["taskWorkflows"])
                    page.locator("#drawer").get_by_role("tab", name="执行记录").click()
                    page.locator('#drawer [data-command="accept"]').first.click()
                    expect(page.locator("#drawer")).not_to_be_visible()
                    expect(detail).to_contain_text("已关闭")
                    open_latest()
                    expect(page.locator("#drawer")).to_contain_text("已关闭")
                    expect(page.locator("#drawer .task-workflow")).to_contain_text("已完成")
                    page.locator('#drawer [data-command="reopen"]').first.click()
                    action_form = page.locator(".semi-modal-content form")
                    action_form.locator('[name="text"]').fill("继续验证并直接完成")
                    page.locator("#dialog-submit").click()
                    expect(action_form).not_to_be_visible()
                    wait_rounds(4)
                    open_latest()
                    expect(page.locator("#drawer .task-workflow")).to_contain_text("待验收")
                    page.locator('#drawer [data-command="take"]').first.click()
                    open_latest()
                    expect(page.locator("#drawer .task-workflow")).to_contain_text("你处理中")
                    page.locator('#drawer [data-command="human_done"]').first.click()
                    action_form = page.locator(".semi-modal-content form")
                    action_form.locator('[name="text"]').fill("人工检查全部完成，结果正确")
                    page.locator("#dialog-submit").click()
                    expect(action_form).not_to_be_visible()
                    open_latest()
                    expect(page.locator("#drawer .task-workflow")).to_contain_text("待验收")
                    if os.environ.get("STUDIO_TEST_SCREENSHOT"):
                        page.keyboard.press("Escape")
                        detail.get_by_role("tab", name="处理与对话").click()
                        page.screenshot(path=os.environ["STUDIO_TEST_SCREENSHOT"])
                        open_latest()
                    page.set_viewport_size({"width": 760, "height": 820})
                    expect(page.locator('#drawer [data-command="accept"]').first).to_be_visible()
                    page.keyboard.press("Escape")
                    detail.get_by_role("tab", name="处理与对话").click()
                    detail.get_by_role("button", name="验收通过").click()
                    page.get_by_role("combobox", name="任务状态").select_option("closed")
                    expect(detail).to_contain_text("已关闭")
                    assert not errors, errors
                    print("Lifecycle UI passed: clarification, rework, closure, reopening, human handoff and narrow layout.")
                finally:
                    browser.close()
        finally:
            if process.poll() is None:
                process.stdin.write("stop\n")
                process.stdin.flush()
                process.wait(timeout=45)
