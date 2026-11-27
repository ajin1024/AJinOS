export const defaultRepository = "ajin1024/AJinOS";
const repositoryPattern = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Builds one of the few GitHub links the desktop may open in the system browser.
 * Callers pass a target instead of a URL so the renderer cannot open arbitrary pages.
 */
export function githubLink(target, { repo = defaultRepository, tag } = {}) {
  if (typeof repo !== "string" || !repositoryPattern.test(repo)) throw new Error("GitHub 仓库配置无效");
  const root = "https://github.com/" + repo;
  if (target === "repo") return root;
  if (target === "releases") return root + "/releases";
  if (target === "release") {
    if (typeof tag !== "string" || !stableTag.test(tag)) throw new Error("只能打开正式版本的发布页");
    return root + "/releases/tag/" + tag;
  }
  throw new Error("无效的 GitHub 链接");
}