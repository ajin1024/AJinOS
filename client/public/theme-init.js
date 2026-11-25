// Resolve before first paint, including when the application bundle has not loaded yet.
(() => {
  let mode = "system";
  try {
    mode = localStorage.getItem("studio-theme") || "system";
  } catch {}
  if (!["light", "dark", "system"].includes(mode)) mode = "system";
  const resolved = mode === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  const syncBody = () => {
    if (!document.body) return;
    if (document.documentElement.dataset.theme === "dark") document.body.setAttribute("theme-mode", "dark");
    else document.body.removeAttribute("theme-mode");
  };
  document.addEventListener("DOMContentLoaded", syncBody, { once: true });
  new MutationObserver(syncBody).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
})();
