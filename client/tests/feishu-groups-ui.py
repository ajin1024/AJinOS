# Prevent group edits from leaking into the table before Save and keep search, mentions, and the schedule usable.
import argparse
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import tempfile
from threading import Thread

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--screenshots", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
script = """
import { startDemoStudio as startStudio } from './client/tests/studio-fixtures.mjs';
const s = await startStudio({home:process.argv[1], port:0, autostart: true});
console.log(JSON.stringify(s.url));
process.stdin.once('data', async () => { await s.close(); process.exit(); });
"""

with tempfile.TemporaryDirectory(prefix="studio-feishu-table-") as home:
    process = subprocess.Popen(
        ["node", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, home],
        cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, encoding="utf-8",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    ready = Queue()
    Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
    owner = {"id": "ou_owner", "name": "本人", "kind": "user"}
    member = {"id": "ou_member", "name": "李研发", "kind": "user"}
    robot = {"id": "ou_robot", "name": "联调助手", "kind": "bot"}
    groups = [
        {"id": "oc_one", "name": "产品联调群", "mode": "mentions", "targets": [owner, robot]},
        {"id": "oc_two", "name": "项目协作群", "mode": "all", "targets": []},
    ]
    data = {"configured": True, "groups": groups, "owner": owner, "interval": 5,
            "intervals": [1, 5, 10, 15, 30], "timezone": "Asia/Shanghai", "revision": "1"}
    known = {entry["id"]: entry["name"] for entry in groups}
    known["oc_new"] = "设计评审群"
    people = {person["id"]: person for person in (owner, member, robot)}
    writes = []

    def feishu(route):
        request = route.request
        if request.url.endswith("/search"):
            assert request.post_data_json == {"query": "设计评审群"}
            route.fulfill(json={"groups": [{"id": "oc_new", "name": "设计评审群"}], "partial": False})
        elif request.url.endswith("/members"):
            route.fulfill(json={"targets": list(people.values()), "partial": False})
        elif request.method == "PUT":
            write = request.post_data_json
            assert write["revision"] == data["revision"]
            writes.append(write)
            data["interval"] = write["interval"]
            data["revision"] = str(int(data["revision"]) + 1)
            data["groups"] = [
                {"id": row["id"], "name": known[row["id"]], "mode": row["mode"],
                 "targets": [people[target] for target in row["targetIds"]]}
                for row in write["groups"]
            ]
            route.fulfill(json=data)
        else:
            route.fulfill(json=data)

    try:
        url = json.loads(ready.get(timeout=45))
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.route("**/api/feishu-groups**", feishu)
            page.goto(url)
            page.locator("#nav [data-view='settings']").click()
            page.locator("[data-settings-section='feishu']").click()
            table = page.get_by_role("table", name="采集群聊")
            expect(table).to_be_visible(timeout=5000)
            drawer = page.get_by_role("complementary", name="编辑群聊")
            expect(drawer).to_have_count(0)
            row = table.get_by_role("row").filter(has_text="产品联调群")
            expect(row).to_contain_text("本人、联调助手")
            row.get_by_role("button", name="编辑").click()
            expect(drawer).to_be_visible()
            assert drawer.bounding_box()["x"] >= table.bounding_box()["x"] + table.bounding_box()["width"]
            if args.screenshots:
                args.screenshots.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=args.screenshots / "feishu-groups-B.png")
            drawer.get_by_role("radio", name="全部消息").check()
            expect(row).to_contain_text("仅 @ 消息")
            drawer.get_by_role("button", name="取消", exact=True).click()
            expect(drawer).to_have_count(0)
            assert writes == []

            page.get_by_role("button", name="添加群聊", exact=True).click()
            drawer = page.get_by_role("complementary", name="添加群聊")
            expect(drawer.get_by_role("button", name="保存", exact=True)).to_be_disabled()
            drawer.get_by_role("searchbox", name="群聊名称").fill("设计评审群")
            drawer.get_by_role("searchbox", name="群聊名称").press("Enter")
            expect(drawer.get_by_role("radio", name="仅 @ 消息")).to_be_checked()
            expect(table.get_by_text("设计评审群", exact=True)).to_have_count(0)
            drawer.get_by_role("button", name="选择成员和机器人").click()
            drawer.get_by_role("searchbox", name="筛选用户或机器人").fill("联调")
            drawer.get_by_role("checkbox", name="联调助手 机器人").check()
            drawer.get_by_role("button", name="保存", exact=True).click()
            expect(drawer).to_have_count(0)
            expect(table.get_by_role("row").filter(has_text="设计评审群")).to_contain_text("本人、联调助手")
            assert writes[-1]["groups"][-1] == {"id": "oc_new", "mode": "mentions", "targetIds": ["ou_owner", "ou_robot"]}
            schedule = page.get_by_role("combobox", name="扫描周期")
            schedule.click()
            page.get_by_role("option", name="每 10 分钟").click()
            page.get_by_role("button", name="保存周期").click()
            expect(page.get_by_role("button", name="保存周期")).to_be_disabled()
            assert writes[-1]["interval"] == 10
            assert len(writes[-1]["groups"]) == 3
            page.reload()
            expect(table.get_by_text("设计评审群", exact=True)).to_be_visible()
            expect(schedule).to_contain_text("每 10 分钟")
            page.set_viewport_size({"width": 850, "height": 650})
            page.locator("#status-capsule").click()
            page.locator('[data-theme-choice="dark"]').click()
            page.locator("#status-capsule").click()
            table.get_by_role("row").filter(has_text="设计评审群").get_by_role("button", name="编辑").click()
            drawer = page.get_by_role("complementary", name="编辑群聊")
            expect(drawer).to_be_visible()
            expect(page.locator("html")).to_have_attribute("data-theme", "dark")
            if args.screenshots:
                page.screenshot(path=args.screenshots / "feishu-groups-B-dark-compact.png")
            drawer.get_by_role("radio", name="全部消息").check()
            drawer.get_by_role("button", name="保存", exact=True).click()
            expect(drawer).to_have_count(0)
            expect(table.get_by_role("row").filter(has_text="设计评审群")).to_contain_text("全部消息")
            assert writes[-1]["interval"] == 10
            browser.close()
        print("PASS: 表格、右侧栏、取消、查群、@ 机器人、独立保存周期、重新打开、窄窗口夜间模式")
    finally:
        if process.poll() is None:
            process.stdin.write("stop\n")
            process.stdin.flush()
            process.wait(timeout=20)
