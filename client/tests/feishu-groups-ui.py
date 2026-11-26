# Keep Feishu reauthorization in the channel card and enable groups only after a successful preview.
import argparse
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import tempfile
from threading import Thread
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--screenshots", type=Path)
parser.add_argument("--cdp")
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
    data = {"configured": False, "groups": [], "owner": owner, "interval": 5,
            "intervals": [1, 5, 10, 15, 30], "timezone": "Asia/Shanghai", "revision": "1"}
    known = {entry["id"]: entry["name"] for entry in groups}
    known["oc_new"] = "设计评审群"
    people = {person["id"]: person for person in (owner, member, robot)}
    writes = []

    def feishu(route):
        request = route.request
        if request.url.endswith("/search"):
            assert request.post_data_json == {"query": "设计评审群"}
            route.fulfill(json={"groups": [
                {"id": "oc_new", "name": "设计评审群"},
                {"id": "oc_other", "name": "内容设计评审群"}
            ], "partial": False})
        elif request.url.endswith("/test"):
            assert request.post_data_json["id"] == "oc_new"
            route.fulfill(json={"testId": "fixture-preview", "sample": {
                "sender": "陈雨", "text": "请看看需求文档", "time": "2026-11-26T02:32:00Z"
            }})
        elif request.url.endswith("/enable"):
            write = request.post_data_json
            assert write["revision"] == data["revision"]
            assert write["testId"] == "fixture-preview"
            writes.append(write)
            data["configured"] = True
            data["revision"] = "2"
            data["groups"] = [*groups, {**write["group"], "name": known["oc_new"],
                "targets": [people[target] for target in write["group"]["targetIds"]]}]
            route.fulfill(json=data)
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
            browser = playwright.chromium.connect_over_cdp(args.cdp) if args.cdp else playwright.chromium.launch(channel="msedge", headless=True)
            page = browser.contexts[0].pages[0] if args.cdp else browser.new_page(viewport={"width": 1440, "height": 900})
            page.set_viewport_size({"width": 1672, "height": 941})
            page.route("**/api/feishu-groups**", feishu)
            page.route("**/api/notification-channels", lambda route: route.fulfill(status=404, json={"error": "没有这个接口"}))
            status = {"installed": True, "ready": True, "userReady": True, "openId": owner["id"], "userName": "林晓"}
            apply_attempts = []

            def enable_notification(route):
                apply_attempts.append(route.request.post_data_json)
                if len(apply_attempts) == 1:
                    route.fulfill(status=404, json={"error": "没有这个地址"})
                    return
                status["notification"] = {"configured": True, "accountMatches": True, "canConfigure": True}
                status["restartRequired"] = True
                route.fulfill(json={"restartRequired": True})

            page.route("**/api/feishu/auth/status", lambda route: route.fulfill(json=status))
            page.route("**/api/feishu/auth/apply", enable_notification)
            page.route("**/api/feishu/auth/qr", lambda route: route.fulfill(json={"deviceCode": "test-device", "userCode": "TEST"}))
            page.route("**/api/feishu/auth/complete", lambda route: route.fulfill(json={"ok": route.request.post_data_json == {"deviceCode": "test-device"}}))
            page.goto(page.url.split("#", 1)[0] if args.cdp else url)
            page.goto(page.url.split("#", 1)[0] + "#settings/feishu")
            expect(page.get_by_role("heading", name="消息渠道")).to_be_visible()
            receiver = page.get_by_role("region", name="桌面端消息接收器")
            expect(receiver.get_by_text("内置", exact=True)).to_be_visible()
            notify = receiver.get_by_role("switch", name="系统通知提醒")
            expect(notify).to_be_checked()
            notify.click()
            expect(notify).not_to_be_checked()
            page.reload()
            expect(notify).not_to_be_checked()
            notify.click()
            receiver.get_by_role("button", name="前往消息中心").click()
            expect(page).to_have_url(page.url.split("#", 1)[0] + "#messages")
            page.goto(page.url.split("#", 1)[0] + "#settings/feishu")
            page.locator("#rail-theme").click()
            page.locator('[data-theme-choice="light"]').click()
            expect(page.get_by_text("已授权", exact=True)).to_be_visible()
            expect(page.get_by_text("连接详情", exact=True)).to_have_count(0)
            expect(page.get_by_text("没有这个接口", exact=True)).to_have_count(0)
            feishu_card = page.get_by_role("region", name="飞书", exact=True)
            reauthorize = feishu_card.get_by_role("button", name="重新扫码授权")
            reauthorize.click()
            scan = page.get_by_role("dialog", name="飞书扫码授权")
            expect(scan.get_by_text("验证码 TEST", exact=True)).to_be_visible()
            scan.get_by_role("button", name="我已扫码确认").click()
            expect(scan).not_to_be_visible()
            expect(feishu_card.get_by_text("已授权", exact=True)).to_be_visible()
            feishu_card.get_by_role("button", name="开启私聊通知").click()
            expect(page.get_by_text("请退出并重新打开 AJinOS，再开启私聊通知。", exact=True)).to_be_visible()
            feishu_card.get_by_role("button", name="开启私聊通知").click()
            feishu_card.get_by_role("button", name="重启引擎以生效").click()
            restart = page.get_by_role("dialog", name="重启引擎")
            expect(restart).to_be_visible()
            restart.get_by_role("button", name="取消").click()
            expect(restart).not_to_be_visible()
            if args.screenshots:
                args.screenshots.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=args.screenshots / "AJinOS-Feishu-Card.png", animations="disabled")
            page.get_by_role("button", name="添加其他来源").click()
            picker = page.get_by_role("dialog").filter(has=page.get_by_role("heading", name="添加其他来源"))
            expect(picker.get_by_role("heading", name="更多平台，敬请期待")).to_be_visible()
            for platform in ("钉钉", "企微", "Slack", "Discord"):
                platform_option = picker.get_by_role("button", name=platform)
                expect(platform_option).to_be_disabled()
                expect(platform_option).to_contain_text("暂未开放")
            expect(picker.get_by_role("list", name="接入步骤")).to_have_count(0)
            expect(picker.locator("input")).to_have_count(0)
            if args.screenshots:
                page.screenshot(path=args.screenshots / "AJinOS-Channel-Coming-Soon.png", animations="disabled")
            page.keyboard.press("Escape")
            expect(picker).not_to_be_visible()
            page.locator("[data-settings-section='connections']").click()
            page.get_by_role("button", name="添加来源").click()
            source = page.get_by_role("dialog").filter(has=page.get_by_role("heading", name="添加来源"))
            source_id = f"partner-{uuid4().hex[:8]}"
            source_name = f"合作方事件 {source_id}"
            source.get_by_role("textbox", name="编号").fill(source_id)
            source.get_by_role("textbox", name="名称").fill(source_name)
            source.get_by_role("button", name="保存配置").click()
            expect(source).not_to_be_visible()
            expect(page.get_by_text(source_name, exact=True)).to_be_visible()
            page.locator("[data-settings-section='feishu']").click()
            page.get_by_role("button", name="添加采集群").click()
            drawer = page.get_by_role("complementary", name="添加采集群")
            enable = drawer.get_by_role("button", name="启用采集", exact=True)
            test_read = drawer.get_by_role("button", name="测试读取")
            expect(test_read).to_be_disabled()
            expect(enable).to_be_disabled()
            drawer.get_by_role("searchbox", name="搜索群名称").fill("设计评审群")
            drawer.get_by_role("searchbox", name="搜索群名称").press("Enter")
            drawer.get_by_role("radio", name="设计评审群", exact=True).check()
            assert drawer.get_by_role("radio", name="设计评审群", exact=True).bounding_box()["width"] <= 18
            expect(drawer.get_by_role("radio", name="仅采集 @ 我的消息")).to_be_checked()
            expect(enable).to_be_disabled()
            test_read.click()
            expect(drawer.get_by_text("读取成功", exact=True)).to_be_visible()
            expect(drawer.get_by_text("陈雨", exact=True)).to_be_visible()
            card = page.get_by_role("region", name="飞书").bounding_box()
            assert drawer.bounding_box()["x"] >= card["x"] + card["width"] + 16
            result = drawer.get_by_role("status").bounding_box()
            assert 0 <= enable.bounding_box()["y"] - result["y"] - result["height"] <= 90
            assert writes == []
            drawer.get_by_role("radio", name="采集全部消息").check()
            expect(enable).to_be_disabled()
            drawer.get_by_role("radio", name="仅采集 @ 我的消息").check()
            test_read.click()
            expect(enable).to_be_enabled()
            if args.screenshots:
                args.screenshots.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=args.screenshots / "AJinOS-Feishu-Desktop.png")
            enable.click()
            expect(drawer).to_have_count(0)
            assert writes[-1]["group"] == {"id": "oc_new", "mode": "mentions", "targetIds": ["ou_owner"]}
            table = page.get_by_role("table", name="采集群聊")
            expect(table).to_be_visible(timeout=5000)
            drawer = page.get_by_role("complementary", name="编辑群聊")
            expect(drawer).to_have_count(0)
            row = table.get_by_role("row").filter(has_text="产品联调群")
            expect(row).to_contain_text("本人、联调助手")
            row.get_by_role("button", name="编辑").click()
            expect(drawer).to_be_visible()
            drawer.get_by_role("radio", name="采集全部消息").check()
            expect(row).to_contain_text("仅 @ 消息")
            drawer.get_by_role("button", name="取消", exact=True).click()
            expect(drawer).to_have_count(0)
            assert len(writes) == 1

            table.get_by_role("row").filter(has_text="设计评审群").get_by_role("button", name="编辑").click()
            drawer.get_by_text("@ 对象设置", exact=True).click()
            drawer.get_by_role("button", name="选择成员和机器人").click()
            drawer.get_by_role("searchbox", name="筛选用户或机器人").fill("联调")
            drawer.get_by_role("checkbox", name="联调助手 机器人").check()
            drawer.get_by_role("button", name="保存", exact=True).click()
            expect(drawer).to_have_count(0)
            expect(table.get_by_role("row").filter(has_text="设计评审群")).to_contain_text("本人、联调助手")
            assert writes[-1]["groups"][-1] == {"id": "oc_new", "mode": "mentions", "targetIds": ["ou_owner", "ou_robot"]}
            page.get_by_text("扫描设置", exact=True).click()
            schedule = page.get_by_role("combobox", name="扫描周期")
            schedule.click()
            page.get_by_role("option", name="每 10 分钟").click()
            page.get_by_role("button", name="保存周期").click()
            expect(page.get_by_role("button", name="保存周期")).to_be_disabled()
            assert writes[-1]["interval"] == 10
            assert len(writes[-1]["groups"]) == 3
            page.reload()
            expect(table.get_by_text("设计评审群", exact=True)).to_be_visible()
            page.get_by_text("扫描设置", exact=True).click()
            expect(schedule).to_contain_text("每 10 分钟")
            page.set_viewport_size({"width": 850, "height": 650})
            page.locator("#rail-theme").click()
            page.locator('[data-theme-choice="dark"]').click()
            table.get_by_role("row").filter(has_text="设计评审群").get_by_role("button", name="编辑").click()
            drawer = page.get_by_role("complementary", name="编辑群聊")
            expect(drawer).to_be_visible()
            expect(page.locator("html")).to_have_attribute("data-theme", "dark")
            if args.screenshots:
                page.screenshot(path=args.screenshots / "AJinOS-Feishu-Desktop-Dark.png")
            drawer.get_by_role("radio", name="采集全部消息").check()
            drawer.get_by_role("button", name="保存", exact=True).click()
            expect(drawer).to_have_count(0)
            expect(table.get_by_role("row").filter(has_text="设计评审群")).to_contain_text("全部消息")
            assert writes[-1]["interval"] == 10
            if not args.cdp:
                browser.close()
        print("PASS: 内置消息接收器、通知开关、添加来源、选群试读及启用、窄窗口夜间模式")
    finally:
        if process.poll() is None:
            process.stdin.write("stop\n")
            process.stdin.flush()
            process.wait(timeout=20)
