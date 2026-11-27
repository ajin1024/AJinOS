# Prevent long version notes from displacing update controls or the close button.
# Exercise source and Windows installer update actions without switching the running app.
import os
from pathlib import Path
import re

from playwright.sync_api import expect, sync_playwright
from studio_browser import running_studio, wait_online


FIXTURE = """
({installed, preview = false}) => {
  const current = installed ? {label: "v1.4.2"} : {
    root: "current", label: "开发版 4fc2efac", dirty: true,
    notes: preview ? [
      "改进总管消息流与待验收提醒", "优化工单的执行记录和详情面板",
      "长期记忆支持搜索、编辑和草案审核", "版本面板支持打开 GitHub 发布页",
      "提交记录 5", "提交记录 6", "提交记录 7", "提交记录 8"
    ].join("\\n") : Array.from({length: 8}, (_, i) => "提交记录 " + (i + 1)).join("\\n")
  };
  const release = {id: "next", label: "v1.5.0", notes: installed
    ? "新增规则优先级设置\\n优化总管消息查看体验"
    : "第一条更新说明\\n" + "长".repeat(1600)};
  const packageInfo = {repo: "ajin1024/AJinOS", state: "idle"};
  const info = installed ? {current, installed, packageUpdate: packageInfo} : {
    current, canSwitch: true, source: "https://github.com/ajin1024/AJinOS.git",
    history: preview ? [] : [{
      id: "previous", root: "old", label: "v1.4.1", notes: "旧版说明", installedAt: "2026-11-25T07:00:00Z"
    }]
  };
  window.versionActions = [];
  window.studio = {
    versions: async (action, id) => {
      window.versionActions.push([action, id ?? null]);
      if (action !== "check") return info;
      return installed
        ? {...info, packageUpdate: {...packageInfo, state: "waiting", tag: release.label,
          message: "下载完成，任务空闲后自动安装", notes: release.notes}}
        : {...info, available: [release], checkedAt: "2026-11-27T02:00:00Z"};
    },
    openGitHub: async (target, tag) => window.versionActions.push([target, tag ?? null])
  };
}
"""


def open_versions(page):
    page.locator("#open-versions").click()
    panel = page.get_by_role("dialog", name="版本与更新")
    expect(panel.locator(".version-current")).to_be_visible()
    return panel


def capture(page, name):
    if path := os.environ.get("STUDIO_UI_SCREENSHOTS"):
        target = Path(path)
        target.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=target / f"versions-{name}.png", animations="disabled")


with running_studio("studio-versions-ui-") as url, sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 720}, reduced_motion="reduce")
    page.add_init_script(f"({FIXTURE})({{installed: false}})")
    page.goto(url)
    wait_online(page)
    panel = open_versions(page)
    show_more = panel.get_by_text("显示其余 4 条", exact=True)
    expect(show_more).to_be_visible(timeout=3000)
    expect(panel.get_by_text("提交记录 8", exact=True)).to_be_hidden()
    capture(page, "light")
    show_more.click()
    expect(panel.get_by_text("提交记录 8", exact=True)).to_be_visible()
    panel.get_by_text("收起提交记录", exact=True).click()

    panel.get_by_role("button", name="检查更新").click()
    expect(panel.get_by_role("heading", name=re.compile("发现新版本.*v1.5.0"))).to_be_visible()
    panel.get_by_role("button", name="更新并重启").click()
    expect(panel.get_by_role("button", name="确认切换")).to_be_in_viewport()
    panel.get_by_role("button", name="暂不切换").click()
    expect(panel.get_by_role("button", name="确认切换")).to_be_hidden()
    panel.get_by_role("button", name="更新并重启").click()
    panel.get_by_role("button", name="确认切换").click()
    assert ["update", "next"] in page.evaluate("window.versionActions")

    page.set_viewport_size({"width": 390, "height": 640})
    panel.get_by_text("查看更新内容", exact=True).click()
    expect(panel.get_by_text("旧版说明", exact=True)).to_be_visible()
    panel.get_by_role("button", name="回滚到此版本").click()
    expect(panel.get_by_role("button", name="确认切换")).to_be_in_viewport()
    expect(panel.get_by_role("button", name="close")).to_be_in_viewport()
    assert panel.evaluate("""el => {
      const body = el.querySelector('.semi-modal-body');
      return el.getBoundingClientRect().width <= innerWidth && body.scrollWidth <= body.clientWidth + 1;
    }""")
    panel.get_by_role("button", name="确认切换").click()
    assert ["rollback", "previous"] in page.evaluate("window.versionActions")
    page.keyboard.press("Escape")
    expect(panel).to_be_hidden()

    page.goto(url + "/#settings/advanced")
    expect(page.get_by_role("heading", name="桌面端版本与更新")).to_be_visible()
    expect(page.locator(".version-current")).to_contain_text("开发版 4fc2efac")

    page = browser.new_page(viewport={"width": 1280, "height": 720}, color_scheme="dark", reduced_motion="reduce")
    page.add_init_script(f"({FIXTURE})({{installed: false, preview: true}})")
    page.goto(url + "/#messages")
    wait_online(page)
    panel = open_versions(page)
    expect(panel.get_by_role("button", name="检查更新")).to_be_visible()
    capture(page, "desktop-dark")

    page = browser.new_page(viewport={"width": 1280, "height": 720}, color_scheme="dark", reduced_motion="reduce")
    page.add_init_script(f"({FIXTURE})({{installed: true}})")
    page.goto(url)
    wait_online(page)
    panel = open_versions(page)
    panel.get_by_role("button", name="v1.4.2").click()
    assert ["release", "v1.4.2"] in page.evaluate("window.versionActions")
    panel.get_by_role("button", name="检查更新").click()
    expect(panel.get_by_text("下载完成，任务空闲后自动安装", exact=True)).to_be_visible()
    expect(panel.get_by_role("button", name="检查更新")).to_be_hidden()
    capture(page, "windows-dark")

    page = browser.new_page(viewport={"width": 390, "height": 640}, color_scheme="dark", reduced_motion="reduce")
    page.goto(url)
    wait_online(page)
    panel = open_versions(page)
    expect(panel.get_by_text(re.compile("浏览器中查看"))).to_be_visible()
    expect(panel.get_by_role("button", name="检查更新")).to_have_count(0)
    capture(page, "browser-dark-narrow")
    browser.close()

print("Version panel passed in Edge for browser, source, and Windows installer views")
