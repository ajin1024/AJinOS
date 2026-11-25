# Prevent settings updates from losing log filters, exposing log text as markup,
# or hiding configuration controls at narrow widths. All engine actions are mocked.
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import sys
import tempfile
from threading import Thread

from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
artifacts = Path(sys.argv[1]) if len(sys.argv) > 1 else None
if artifacts:
    artifacts.mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix="studio-settings-ui-") as home:
    script = """
      import { startDemoStudio as startStudio } from './client/tests/studio-fixtures.mjs';
      const studio = await startStudio({home: process.argv[1], port: 0, autostart: true});
      console.log(JSON.stringify({url:studio.url}));
      process.stdin.once('data', async () => { await studio.close(); process.exit(0); });
    """
    process = subprocess.Popen(["node", "--input-type=module", "-e", script, home], cwd=root,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    ready = Queue()
    Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
    try:
        url = json.loads(ready.get(timeout=45))["url"]
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1600, "height": 1000})
            errors, writes = [], []
            unavailable = False
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.add_init_script("""const NativeEvents = window.EventSource;
                window.EventSource = class extends NativeEvents {
                    constructor(...args) { super(...args); window.testEvents = this; }
                };""")
            logs = [{"at": 1794452400000 + i * 5000,
                     "text": f"[worker] run {570 + i} · 项目任务处理完成"} for i in range(80)]
            logs[2]["text"] = '[worker] failed <img src=x onerror="window.logInjected=1">'
            def protect(route):
                if route.request.method not in ("GET", "HEAD"):
                    writes.append(route.request.url)
                    route.abort()
                elif route.request.url.endswith("/api/engine"):
                    if unavailable:
                        route.fulfill(status=503, json={"error": "引擎暂时不可用"})
                    else:
                        route.fulfill(json={"logs": logs})
                else:
                    route.continue_()
            page.route("**/api/**", protect)
            page.goto(url + "#settings/logs")
            search = page.get_by_role("searchbox", name="搜索引擎日志")
            expect(search).to_be_visible()
            expect(page.locator(".engine-log-row")).to_have_count(80)
            expect(page.locator("#engine-log img")).to_have_count(0)
            search.fill("FAILED")
            expect(page.locator(".engine-log-row")).to_have_count(1)
            page.get_by_role("button", name="刷新日志", exact=True).click()
            expect(search).to_have_value("FAILED")
            expect(page.locator(".engine-log-row")).to_have_count(1)
            search.focus()
            search.evaluate("e => e.setSelectionRange(2, 2)")
            page.evaluate("""async () => {
                const snapshot = await (await fetch('/api/state')).json();
                snapshot.enginePid = 12345;
                window.testEvents.dispatchEvent(new MessageEvent('snapshot', {data: JSON.stringify(snapshot)}));
            }""")
            expect(search).to_be_focused()
            expect(search).to_have_value("FAILED")
            assert search.evaluate("e => e.selectionStart") == 2
            unavailable = True
            page.get_by_role("button", name="刷新日志", exact=True).click()
            expect(page.locator("#engine-log-updated")).to_contain_text("读取失败")
            expect(page.locator(".engine-log-row")).to_have_count(1)
            unavailable = False
            page.get_by_role("button", name="刷新日志", exact=True).click()
            expect(page.locator("#engine-log-updated")).to_contain_text("更新于")
            search.fill("没有这条日志")
            expect(page.locator("#engine-log")).to_contain_text("没有匹配的日志")
            search.fill("")
            page.get_by_role("checkbox", name="自动换行").uncheck()
            expect(page.locator("#engine-log")).to_have_class("sc-logs-surface engine-log-view is-nowrap")
            page.get_by_role("checkbox", name="自动换行").check()
            for theme in ("light", "dark"):
                page.locator("#status-capsule").click()
                page.locator(f'[data-theme-choice="{theme}"]').click()
                page.locator("#status-capsule").click()
                page.get_by_role("button", name="最新记录", exact=True).click()
                assert page.locator("#engine-log").evaluate("e => e.scrollHeight - e.scrollTop - e.clientHeight < 3")
                for section, heading in (("runtime", "运行环境与引擎"), ("gateway", "项目识别网关"), ("advanced", "高级 JSON 与版本")):
                    page.locator(f'[data-settings-section="{section}"]').click()
                    expect(page.get_by_role("heading", name=heading, exact=True)).to_be_visible()
                page.locator('[data-settings-section="logs"]').click()
                if artifacts:
                    page.screenshot(path=str(artifacts / f"settings-{theme}.png"), full_page=True)
            for width in (1280, 900, 390):
                page.set_viewport_size({"width": width, "height": 844})
                assert page.locator("#main").evaluate("e => e.scrollWidth <= e.clientWidth + 1")
                expect(search).to_be_visible()
                if artifacts:
                    page.screenshot(path=str(artifacts / f"settings-{width}.png"), full_page=True)
            assert not writes, writes
            assert not errors, errors
            browser.close()
        print("PASS: settings center sections, safe log search, refresh, wrap, latest, themes and narrow layout")
    finally:
        if process.poll() is None:
            process.stdin.write("stop\n")
            process.stdin.flush()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                else:
                    process.kill()
                process.wait()
