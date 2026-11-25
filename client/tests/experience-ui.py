# Prevent navigation from dropping an unsent message and reduced-motion mode from running UI transitions.
# Prevent the mobile conversation list from crowding out the active conversation.
# Prevent real task submission, new timeline messages, or a workbench redraw from stealing the user's place.
# Keep the workbench navigation and its accessible region under the same short name.
from base64 import b64decode
from studio_home import studio_home
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
from threading import Thread

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
SERVER = """
import { startDemoStudio as startStudio } from './client/tests/studio-fixtures.mjs';
const server = await startStudio({
  home: process.argv[1], port: 0, autostart: true,
  gatewayModel: async (kind) => kind === 'confirm'
    ? { confirmed: false, question: '希望交付什么？' }
    : { project: 'orders', flow: 'default', certain: true, candidates: ['orders'] },
});
console.log(JSON.stringify({ url: server.url }));
process.stdin.once('data', async () => { await server.close(); process.exit(0); });
"""


def navigate(page, view):
    page.locator(f'#nav [data-view="{view}"]').click()
    expect(page.locator('#nav [aria-current="page"]')).to_have_attribute("data-view", view)


with studio_home('studio-experience-') as home:
    with open(Path(home) / "server.log", "w", encoding="utf-8") as log:
        server = subprocess.Popen(
            ["node", "--input-type=module", "-e", SERVER, home],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
            text=True, encoding="utf-8",
        )
        ready = Queue()
        Thread(target=lambda: ready.put(server.stdout.readline()), daemon=True).start()
        try:
            url = json.loads(ready.get(timeout=45))["url"]
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="msedge", headless=True)
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                page.add_init_script("""window.studio = {
                  onFocusComposer(callback) { window.testFocusComposer = callback; }
                };""")
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(url)
                expect(page.locator("#nav").get_by_role("button", name="工作台", exact=True)).to_be_visible(timeout=3000)
                expect(page.get_by_role("region", name="工作台", exact=True)).to_be_visible()
                expect(page.locator(".fc-canvas")).to_be_visible()
                gateway = page.locator('[data-node="gateway"]')
                gateway.focus()
                page.emulate_media(reduced_motion="reduce")
                expect(gateway).to_be_focused()
                navigate(page, "messages")
                composer = page.locator(".mc-textarea")
                composer.fill("还没发出的任务说明")
                png = b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==")
                page.locator('.mc-composer input[type="file"]').set_input_files(
                    {"name": "验收图片.png", "mimeType": "image/png", "buffer": png}
                )
                expect(page.locator(".mc-composer-thumb.done")).to_be_visible()
                navigate(page, "tasks")
                navigate(page, "projects")
                navigate(page, "settings")
                navigate(page, "messages")
                expect(composer).to_have_value("还没发出的任务说明")
                expect(page.locator(".mc-composer-thumb.done")).to_be_visible()
                page.locator("#status-capsule").click()
                page.locator("#refresh-app").click()
                expect(page.locator("#toast")).to_contain_text("未发送的草稿")
                page.emulate_media(reduced_motion="reduce")
                assert page.locator("#new-task").evaluate(
                    "(button) => getComputedStyle(button).transitionDuration.split(',').every(t => parseFloat(t) === 0)"
                )
                page.locator("#status-capsule").click()
                page.locator("#studio-status-menu").get_by_role("button", name="新建任务", exact=True).click()
                expect(page.get_by_role("dialog", name="发起新任务")).to_be_visible()
                page.keyboard.press("Escape")
                expect(page.get_by_role("dialog", name="发起新任务")).to_be_hidden()

                page.set_viewport_size({"width": 390, "height": 680})
                page.emulate_media(reduced_motion="no-preference", color_scheme="dark")
                expect(page.get_by_role("button", name="对话列表")).to_be_visible()
                expect(page.get_by_role("complementary", name="会话列表")).to_be_hidden()
                expect(composer).to_be_in_viewport()
                page.get_by_role("button", name="对话列表").press("Enter")
                expect(page.get_by_role("complementary", name="会话列表")).to_be_visible()
                expect(page.get_by_role("button", name="返回对话")).to_be_focused()
                page.evaluate("window.testFocusComposer()")
                expect(composer).to_be_focused()
                page.get_by_role("button", name="对话列表").click()
                page.get_by_role("button", name="返回对话").click()
                expect(page.get_by_role("button", name="对话列表")).to_be_focused()
                expect(composer).to_have_value("还没发出的任务说明")
                assert page.evaluate("document.documentElement.scrollWidth === innerWidth")

                page.set_viewport_size({"width": 1280, "height": 840})
                navigate(page, "projects")
                page.locator("#status-capsule").click()
                page.locator("#studio-status-menu").get_by_role("button", name="新建任务", exact=True).click()
                modal = page.get_by_role("dialog", name="发起新任务")
                modal.get_by_role("textbox").fill("检查演示订单并反馈结果")
                modal.locator('select[name="project"]').select_option("orders")
                modal.locator("summary").click()
                modal.get_by_role("checkbox").check()
                modal.get_by_role("button", name="提交任务").click()
                expect(modal).to_be_hidden()
                expect(page.locator('#nav [aria-current="page"]')).to_have_attribute("data-view", "projects")
                expect(page.locator("#toast")).to_contain_text("已交给")
                navigate(page, "messages")
                page.locator(".mc-conversation").filter(has_text="检查演示订单并反馈结果").click()
                expect(composer).to_have_value("")
                expect(composer).not_to_be_focused()
                composer.fill("已有对话的草稿")
                page.get_by_role("button", name="新对话", exact=True).click()
                expect(composer).to_have_value("还没发出的任务说明")
                page.locator(".mc-conversation").filter(has_text="检查演示订单并反馈结果").click()
                expect(composer).to_have_value("已有对话的草稿")

                intake = page.request.post(url + "/api/messages", headers={"x-studio-action": "1"}, data={
                    "id": "experience-intake", "project": "orders", "text": "需要补充验收要求的任务",
                })
                assert intake.ok and intake.json()["needsConfirmation"], intake.text()
                page.locator(".mc-conversation").filter(has_text="需要补充验收要求的任务").click()
                composer.fill("我还没发出的补充说明")
                navigate(page, "tasks")
                dismissed = page.request.post(
                    url + "/api/gateway/experience-intake/dismiss", headers={"x-studio-action": "1"}, data={}
                )
                assert dismissed.ok, dismissed.text()
                navigate(page, "messages")
                page.locator(".mc-conversation").filter(has_text="我还没发出的补充说明").click()
                expect(page.locator(".mc-timeline")).to_contain_text("原对话已结束")
                expect(composer).to_have_value("我还没发出的补充说明")

                rows = []
                base_time = datetime.now(timezone.utc)

                def append_message(text):
                    rows.append({
                        "id": f"fixture-{len(rows)}",
                        "project": "orders",
                        "topic": "long",
                        "text": text,
                        "at": (base_time + timedelta(seconds=len(rows))).isoformat(),
                    })

                for number in range(120):
                    append_message(f"第 {number + 1} 条历史消息\n工作记录和结果说明。" * 4)

                def serve_timeline(route):
                    if route.request.method == "GET":
                        route.fulfill(json=rows)
                    else:
                        route.continue_()

                page.route("**/api/messages", serve_timeline)
                page.goto(url + "#messages/long")
                timeline = page.locator(".mc-timeline")
                expect(timeline.get_by_text("第 120 条历史消息", exact=False)).to_be_in_viewport()
                timeline.hover()
                page.mouse.wheel(0, -1400)
                page.wait_for_function(
                    """() => { const el = document.querySelector('.mc-timeline');
                    return el.scrollHeight - el.clientHeight - el.scrollTop > 100; }"""
                )
                reading_position = timeline.evaluate("(el) => el.scrollTop")
                append_message("在阅读历史时收到的新消息")

                # A real Hub event causes the same snapshot refresh as an incoming task.
                submit = page.request.post(url + "/api/messages", headers={"x-studio-action": "1"}, data={
                    "id": "experience-refresh", "project": "orders",
                    "text": "核对演示结果", "requirementsConfirmed": True,
                })
                assert submit.ok, submit.text()
                jump = page.get_by_role("button", name="查看新消息")
                expect(jump).to_be_visible(timeout=12000)
                assert abs(timeline.evaluate("(el) => el.scrollTop") - reading_position) < 30
                jump.click()
                expect(timeline.get_by_text("在阅读历史时收到的新消息")).to_be_in_viewport()
                expect(jump).to_be_hidden()
                frames = timeline.evaluate("""el => new Promise(resolve => {
                  const times = [];
                  let previous;
                  function sample(now) {
                    if (previous !== undefined) times.push(now - previous);
                    previous = now;
                    el.scrollTop -= 18;
                    if (times.length < 100) requestAnimationFrame(sample);
                    else resolve(times);
                  }
                  requestAnimationFrame(sample);
                })""")
                frames.sort()
                print(f"Long conversation scroll: p50 {frames[49]:.1f} ms, p95 {frames[94]:.1f} ms, "
                      f"frames over 50 ms: {sum(frame > 50 for frame in frames)}/{len(frames)}")
                page.wait_for_function("""async () => {
                  const {state} = await (await fetch('/api/state')).json();
                  return state?.runs.every(run => !['queued', 'claimed'].includes(run.state));
                }""", timeout=30000)
                assert not errors, errors
                browser.close()
        finally:
            if server.poll() is None:
                server.stdin.write("\n")
                server.stdin.flush()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
