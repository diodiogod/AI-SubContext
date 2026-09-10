(() => {
  const theme = localStorage.getItem("ai-subcontext-modern-theme") || "system";
  const resolvedTheme = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  document.body.dataset.modernTheme = resolvedTheme;
  const params = new URLSearchParams(window.location.search);
  if (params.get("embedded") === "modern") {
    document.body.classList.add("modern-embedded-tool");
    document.querySelector("[data-console-link]")?.remove();
    return;
  }
  if (params.get("from") !== "modern") return;

  const page = document.body.classList.contains("review-page") ? "subtitles" : "prompt";
  const pathJobId = window.location.pathname.match(/^\/review\/([^/]+)/)?.[1] || "";
  const rememberedWorkspace = localStorage.getItem("ai-subcontext-modern-workspace") || "";
  const rememberedJobId = rememberedWorkspace.match(/\/review\/([^/?#]+)/)?.[1] || "";
  const jobId = decodeURIComponent(pathJobId || rememberedJobId);
  const jobQuery = jobId ? `?job=${encodeURIComponent(jobId)}` : "";
  const subtitlesUrl = page === "subtitles"
    ? window.location.href
    : (rememberedWorkspace || "#");

  document.body.classList.add("modern-ui", "modern-tool-ui");

  const sidebar = document.createElement("aside");
  sidebar.className = "modern-sidebar";
  sidebar.innerHTML = `
    <div class="modern-brand"><span>AI</span> SubContext</div>
    <nav class="modern-primary-nav" aria-label="Application">
      <a href="/modern#setup"><span aria-hidden="true">＋</span> New translation</a>
      <a href="/modern#jobs"><span aria-hidden="true">☷</span> Jobs</a>
      <a href="/modern${jobQuery}#overview"><span aria-hidden="true">◫</span> Current job</a>
    </nav>
    <div class="modern-recent-heading">Recent jobs</div>
    <div class="modern-recent-jobs" data-modern-recent-jobs><div class="modern-recent-loading">Loading jobs…</div></div>
    <div class="modern-sidebar-spacer"></div>
    <nav class="modern-secondary-nav" aria-label="Tools"><a href="/">Legacy interface</a></nav>
  `;

  const topbar = document.createElement("header");
  topbar.className = "modern-topbar modern-tool-topbar";
  topbar.innerHTML = `
    <div><div class="modern-kicker">${page === "subtitles" ? "Subtitle review" : "Translation tools"}</div><h1 data-modern-shell-title>${page === "subtitles" ? "Loading job…" : "Prompt Lab"}</h1></div>
    <nav class="modern-view-tabs" aria-label="Job sections">
      <a href="/modern${jobQuery}#overview">Overview</a>
      <a href="${subtitlesUrl}" class="${page === "subtitles" ? "is-active" : ""}" ${subtitlesUrl === "#" ? 'aria-disabled="true"' : ""}>Subtitles</a>
      <a href="/prompt-lab?from=modern" class="${page === "prompt" ? "is-active" : ""}">Prompt Lab</a>
      <a href="/modern${jobQuery}#settings">Settings</a>
    </nav>
  `;

  const main = document.querySelector("main");
  if (!main) return;
  main.before(sidebar);
  main.prepend(topbar);

  const consoleLink = document.querySelector("[data-console-link]");
  consoleLink?.remove();

  if (page === "subtitles") {
    localStorage.setItem("ai-subcontext-modern-workspace", window.location.href);
    const sourceTitle = document.getElementById("review-page-title");
    const shellTitle = topbar.querySelector("[data-modern-shell-title]");
    const syncTitle = () => { shellTitle.textContent = sourceTitle?.textContent || "Subtitle review"; };
    new MutationObserver(syncTitle).observe(sourceTitle, { childList: true, subtree: true });
    syncTitle();
  }

  async function loadRecentJobs() {
    const target = sidebar.querySelector("[data-modern-recent-jobs]");
    try {
      const response = await fetch("/api/jobs?view=summary");
      if (!response.ok) throw new Error();
      const jobs = await response.json();
      target.innerHTML = "";
      for (const job of jobs.slice(0, 8)) {
        const link = document.createElement("a");
        link.className = "modern-recent-job";
        link.href = `/modern?job=${encodeURIComponent(job.id)}#overview`;
        link.title = job.title || job.filename || "Open job";
        const title = document.createElement("strong");
        title.textContent = job.title || job.filename || "Untitled job";
        const meta = document.createElement("span");
        const translated = Number(job.translated_count ?? job.translated_line_count ?? 0);
        const source = Number(job.source_count ?? job.source_line_count ?? 0);
        meta.textContent = `${translated}/${source} · ${job.status || "saved"}`;
        link.append(title, meta);
        target.append(link);
      }
    } catch {
      target.innerHTML = '<div class="modern-recent-loading">Jobs unavailable</div>';
    }
  }
  void loadRecentJobs();
})();
