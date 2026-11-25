// Prevents regressions where Feishu CLI QR-code login fails to locate lark-cli, parse device flow URL/code,
// or report authenticated openId for one-click channel setup.
import test from "node:test";
import assert from "node:assert/strict";
import {
  completeFeishuQrLogin,
  getFeishuAuthStatus,
  startFeishuQrLogin,
} from "../feishu-auth.mjs";

test("getFeishuAuthStatus parses lark-cli auth status JSON and extracts openId and readiness", async () => {
  const status = await getFeishuAuthStatus({
    lark: "C:\\bin\\lark-cli.exe",
    exists: () => true,
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify({
        appId: "cli_123",
        brand: "feishu",
        identities: {
          bot: { status: "ready", available: true },
          user: {
            status: "ready",
            available: true,
            openId: "ou_owner123",
            userName: "阿锦",
            tokenStatus: "valid",
            expiresAt: "2026-11-23T18:00:00+08:00",
          },
        },
      }),
      stderr: "",
    }),
  });

  assert.equal(status.installed, true);
  assert.equal(status.ready, true);
  assert.equal(status.appId, "cli_123");
  assert.equal(status.openId, "ou_owner123");
  assert.equal(status.userName, "阿锦");
});

test("startFeishuQrLogin returns verification URL, deviceCode, and QR image data URL", async () => {
  const started = await startFeishuQrLogin({
    lark: "C:\\bin\\lark-cli.exe",
    exists: () => true,
    exec: async (_bin, args) => {
      if (args[1] === "login") {
        return {
          code: 0,
          stdout: JSON.stringify({
            device_code: "dev_abc",
            user_code: "ABCD-1234",
            verification_uri_complete: "https://accounts.feishu.cn/device?user_code=ABCD-1234",
            expires_in: 300,
          }),
          stderr: "",
        };
      }
      if (args[1] === "qrcode") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
    readPng: () => Buffer.from([137, 80, 78, 71]),
  });

  assert.equal(started.deviceCode, "dev_abc");
  assert.equal(started.userCode, "ABCD-1234");
  assert.equal(started.url, "https://accounts.feishu.cn/device?user_code=ABCD-1234");
  assert.ok(started.qrDataUrl.startsWith("data:image/png;base64,"));
});

test("completeFeishuQrLogin finishes device flow and returns refreshed auth status", async () => {
  const done = await completeFeishuQrLogin({
    lark: "C:\\bin\\lark-cli.exe",
    deviceCode: "dev_abc",
    exists: () => true,
    exec: async (_bin, args) => {
      if (args[1] === "login") return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
          appId: "cli_123",
          identities: {
            bot: { available: true },
            user: { available: true, openId: "ou_owner123", userName: "阿锦", tokenStatus: "valid" },
          },
        }),
        stderr: "",
      };
    },
  });

  assert.equal(done.ok, true);
  assert.equal(done.status.openId, "ou_owner123");
});
