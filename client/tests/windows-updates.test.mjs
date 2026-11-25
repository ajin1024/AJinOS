// Reject draft, downgraded, and altered installers, and keep a verified update waiting while the Hub is busy.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupName, WindowsUpdates } from "../windows-updates.mjs";

const bytes = Buffer.from("verified installer");
const asset = {
  name: setupName,
  state: "uploaded",
  size: bytes.length,
  digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
};
const release = (tag, fields = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [asset],
  body: "新版说明",
  ...fields,
});

test("only a verified higher stable release can install, and an active engine postpones it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-package-updates-"));
  const states = [];
  const installed = [];
  let busy = true;
  try {
    const updates = new WindowsUpdates({
      version: "1.9.0",
      repo: "test/studio",
      directory,
      publish: (status) => states.push(status.state),
      releases: async () => [
        release("v1.10.0"),
        release("v1.9.9"),
        release("v2.0.0", { draft: true }),
        release("v2.0.0-rc.1", { prerelease: true }),
        release("v3.0.0", { assets: [] }),
        release("v1.8.9"),
      ],
      download: async (candidate, file) => {
        assert.equal(candidate.tag, "v1.10.0");
        await writeFile(file, bytes);
      },
      prepare: async () => {
        if (busy) throw new Error("还有执行中、排队或状态不明的任务");
      },
      install: async (candidate, file) => installed.push({ candidate, file }),
    });
    await updates.check();
    assert.deepEqual(states, ["checking", "downloading", "waiting"]);
    assert.equal(updates.info().tag, "v1.10.0");
    await updates.apply();
    assert.equal(updates.info().state, "waiting");
    assert.match(updates.info().message, /执行中/);
    assert.deepEqual(installed, []);
    busy = false;
    await updates.apply();
    assert.equal(updates.info().state, "installing");
    assert.equal(installed.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 4 });
  }
});

test("integrity failure never reaches installation or stops the Hub", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-corrupt-update-"));
  try {
    const updates = new WindowsUpdates({
      version: "1.9.0",
      repo: "test/studio",
      directory,
      releases: async () => [release("v2.0.0")],
      download: async (_candidate, file) => writeFile(file, Buffer.alloc(bytes.length)),
      prepare: () => assert.fail("Should never ask to stop the Hub"),
      install: () => assert.fail("Should never start an installer"),
    });
    await updates.check();
    await updates.apply();
    assert.equal(updates.info().state, "error");
    assert.match(updates.info().message, /校验/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 4 });
  }
});
