# Prevent hidden project settings, accidental Issue intake, or cache cleanup touching workspace files.
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import tempfile
from threading import Thread

from playwright.sync_api import expect, sync_playwright


root = Path(__file__).resolve().parents[2]
script = """
  import { existsSync } from 'node:fs';
  import path from 'node:path';
  import { setTimeout } from 'node:timers/promises';
  import { startDemoStudio } from './client/tests/studio-fixtures.mjs';
  const home = process.argv[1];
  const studio = await startDemoStudio({ home, port: 0, gatewayModel: async (kind, snapshot, config) => {
    if (kind !== 'profile' || config.roleRouting.roles.plan.primary !== 'codex' || !snapshot.documents[0]?.text.includes('Inventory'))
      throw Error('Expected a background profile using the registered project and global planning role');
    while (!existsSync(path.join(home, 'release-profile'))) await setTimeout(25);
    return { summary: '仓储项目', tags: ['库存管理'], tasks: ['盘点库存'] };
  }});
  console.log(JSON.stringify({url: studio.url}));
  process.stdin.once('data', async () => { await studio.close(); process.exit(0); });
"""

with tempfile.TemporaryDirectory(prefix="studio-project-editor-") as home:
    folder = Path(home) / "inventory"
    folder.mkdir()
    (folder / "README.md").write_text("# Inventory", encoding="utf-8")
    release_profile = Path(home) / "release-profile"
    process = subprocess.Popen(
        ["node", "--input-type=module", "-e", script, home], cwd=root,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    ready = Queue()
    Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
    try:
        url = json.loads(ready.get(timeout=45))["url"]
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1100, "height": 800}, timezone_id="Asia/Shanghai")
            page.set_default_timeout(10_000)
            page.goto(url)
            expect(page.locator('#nav [data-view="messages"]')).to_have_text("对话", timeout=5000)
            page.get_by_role("button", name="能力与沙箱", exact=True).click()

            current = page.request.get(url + "/api/config").json()
            current["value"]["roleRouting"] = {"roles": {"plan": {"primary": "codex"}, "execute": {"primary": "codex"}}}
            response = page.request.put(url + "/api/config", data=current, headers={"x-studio-action": "1", "Origin": url})
            assert response.ok, response.text()
            page.reload()
            page.get_by_role("button", name="添加项目", exact=True).click()
            editor = page.locator(".ps-editor")
            expect(editor.locator('input, textarea, [role="combobox"]')).to_have_count(1)
            editor.locator('input[name="cwd"]').fill(str(folder))
            page.get_by_role("button", name="添加项目", exact=True).click()
            expect(editor).not_to_be_visible(timeout=5000)
            pending_profile = url + "/api/projects/inventory/profile"
            assert page.request.get(pending_profile).json() is None
            current = page.request.get(url + "/api/config").json()["value"]
            added = next(p for p in current["projects"] if p["id"] == "inventory")
            assert added["name"] == "inventory" and added.get("executionMode") != "fixed"
            assert next(r for r in current["rules"]["rules"] if r["name"] == added["rule"])["to"] == "codex"
            release_profile.touch()
            page.get_by_role("button", name="查看inventory", exact=True).click()
            expect(page.get_by_text("库存管理", exact=True)).to_be_visible()
            storage_url = url + "/api/projects/inventory/storage"
            storage = page.request.get(storage_url).json()
            assert storage["workspaceBytes"] == (folder / "README.md").stat().st_size
            assert storage["profileBytes"] > 0
            clear = page.get_by_role("button", name="清空画像缓存", exact=True)
            expect(clear).to_be_enabled()
            clear.click()
            clear_dialog = page.get_by_role("dialog", name="清空画像缓存")
            clear_dialog.get_by_text("确认清空", exact=True).click()
            expect(clear_dialog).not_to_be_visible()
            expect(page.get_by_text("库存管理", exact=True)).not_to_be_visible()
            assert page.request.get(storage_url).json()["profileBytes"] == 0
            assert (folder / "README.md").read_text(encoding="utf-8") == "# Inventory"
            page.get_by_role("button", name="返回项目", exact=True).click()

            def open_orders():
                page.get_by_role("button", name="查看订单服务 · 演示", exact=True).click()
                expect(page.get_by_role("heading", name="订单服务 · 演示", exact=True)).to_be_visible()
                expect(page.get_by_text("演示订单问题的排查、人工决定和复查。", exact=True)).to_be_visible()
                expect(page.locator('input[name="cwd"]')).to_be_visible()
                expect(page.get_by_role("button", name="添加流程", exact=True)).to_be_visible()
                expect(page.get_by_text("更多项目资料", exact=True)).to_have_count(0)

            def issue_settings():
                projects = page.request.get(url + "/api/config").json()["value"]["projects"]
                return next(project["openSource"] for project in projects if project["id"] == "orders")

            open_orders()
            repo = page.locator('input[name="openSourceRepo"]')
            auto = page.get_by_role("switch", name="自动处理 Issue", exact=True)
            custom = page.get_by_role("radio", name="自选时间")
            start_time = page.get_by_label("开始时间", exact=True)
            save = page.get_by_role("button", name="保存项目", exact=True)
            expect(save).to_be_disabled()
            expect(repo).to_be_visible()
            expect(page.get_by_role("switch", name="开源项目", exact=True)).to_have_count(0)
            expect(custom).not_to_be_visible()
            page.locator('input[name="aliases"]').fill("库存, 订单")
            page.locator('input[name="parallel"]').fill("2")
            page.get_by_role("combobox", name="项目权限").click()
            page.get_by_role("option", name="工作区编辑").click()
            page.get_by_role("switch", name="继续同一话题的上下文").click()
            auto.click()
            expect(page.get_by_role("radio", name="从今天起")).to_be_checked()
            expect(start_time).not_to_be_visible()
            save.click()
            expect(page.get_by_text("请填写 GitHub 仓库", exact=True)).to_be_visible()

            repo.fill("https://github.com/ajin1024/AJinOS")
            page.get_by_text("自选时间", exact=True).click()
            expect(start_time).to_have_attribute("type", "datetime-local")
            start_time.fill("2026-11-22T18:30")
            auto.click()
            auto.click()
            expect(start_time).to_have_value("2026-11-22T18:30")
            save.click()
            expect(save).to_be_disabled()
            assert issue_settings()["since"] == "2026-11-22T10:30:00Z"
            expect(repo).to_have_value("ajin1024/AJinOS")
            saved = page.request.get(url + "/api/config").json()["value"]
            orders = next(project for project in saved["projects"] if project["id"] == "orders")
            rule = next(rule for rule in saved["rules"]["rules"] if rule["name"] == orders["rule"])
            assert orders["aliases"] == ["库存", "订单"] and rule["parallel"] == 2 and rule["resume"] is False
            assert rule["access"] == "edit"

            page.get_by_role("button", name="返回项目", exact=True).click()
            open_orders()
            expect(repo).to_have_value("ajin1024/AJinOS")
            expect(custom).to_be_checked()
            expect(start_time).to_have_value("2026-11-22T18:30")
            page.set_viewport_size({"width": 390, "height": 780})
            assert page.locator(".ps-form-scroll").evaluate("el => el.scrollWidth <= el.clientWidth + 1")
            page.get_by_text("全部开放", exact=True).click()
            save.click()
            expect(save).to_be_disabled()
            assert "since" not in issue_settings()
            browser.close()
    finally:
        release_profile.touch(exist_ok=True)
        if process.poll() is None:
            process.stdin.write("stop\n")
            process.stdin.flush()
            process.wait(timeout=25)
