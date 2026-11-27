// Prevent the desktop's GitHub entry from opening a forged URL or a release page that does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRepository, githubLink } from "../github-links.mjs";

test("GitHub links point at the project repository, its release list, and stable release tags", () => {
  assert.equal(githubLink("repo"), `https://github.com/${defaultRepository}`);
  assert.equal(githubLink("releases"), `https://github.com/${defaultRepository}/releases`);
  assert.equal(
    githubLink("release", { tag: "v1.2.3" }),
    `https://github.com/${defaultRepository}/releases/tag/v1.2.3`,
  );
});

test("GitHub links only accept known targets, valid repositories and stable release tags", () => {
  assert.throws(() => githubLink("settings"));
  assert.throws(() => githubLink("release", { tag: "main" }));
  assert.throws(() => githubLink("release", { tag: "v1.2.3\nhttps://evil.example" }));
  assert.throws(() => githubLink("repo", { repo: "https://evil.example/owner/repo" }));
  assert.throws(() => githubLink("repo", { repo: "owner" }));
  assert.equal(githubLink("release", { tag: "v2.10.0" }), "https://github.com/ajin1024/AJinOS/releases/tag/v2.10.0");
  assert.equal(githubLink("repo", { repo: "someone/AJinOS" }), "https://github.com/someone/AJinOS");
});