(() => {
  if (window.location.pathname !== "/modern") return;

  document.body.classList.add("modern-ui");
  const shell = document.querySelector(".console-shell");
  const setupPanel = document.querySelector(".panel-form");
  const overviewPanel = document.getElementById("active-job-card");
  const jobsPanel = document.getElementById("jobs-panel");
  if (!shell || !setupPanel || !overviewPanel || !jobsPanel) return;

  const sidebar = document.createElement("aside");
  sidebar.className = "modern-sidebar";
  sidebar.innerHTML = `
    <div class="modern-brand"><span>AI</span> SubContext</div>
    <nav class="modern-primary-nav" aria-label="Application">
      <button type="button" data-modern-view="setup" title="New translation"><span aria-hidden="true">＋</span> New translation</button>
      <button type="button" data-modern-view="jobs" title="Saved jobs"><span aria-hidden="true">☷</span> Jobs</button>
      <button type="button" data-modern-view="overview" title="Current job"><span aria-hidden="true">◫</span> Current job</button>
    </nav>
    <div class="modern-recent-heading">Recent jobs</div>
    <div class="modern-recent-jobs" data-modern-recent-jobs>
      <div class="modern-recent-loading">Loading jobs…</div>
    </div>
    <div class="modern-sidebar-spacer"></div>
    <nav class="modern-secondary-nav" aria-label="Tools">
      <button type="button" data-modern-view="prompt">Prompt Lab</button>
      <a href="/">Legacy interface</a>
    </nav>
  `;

  const topbar = document.createElement("header");
  topbar.className = "modern-topbar";
  topbar.innerHTML = `
    <div>
      <div class="modern-kicker" data-modern-kicker>Workspace</div>
      <h1 data-modern-title>Current translation</h1>
    </div>
    <div class="modern-view-tabs" role="tablist" aria-label="Job sections">
      <button type="button" role="tab" data-modern-view="overview">Overview</button>
      <button type="button" role="tab" class="modern-job-tab" data-modern-view="subtitles" data-modern-workspace disabled>Subtitles</button>
      <button type="button" role="tab" class="modern-job-tab" data-modern-view="prompt">Prompt Lab</button>
      <button type="button" role="tab" data-modern-view="settings">Settings</button>
    </div>
  `;

  shell.before(sidebar);
  shell.prepend(topbar);

  const toolDeck = document.createElement("section");
  toolDeck.className = "modern-tool-deck";
  toolDeck.innerHTML = `
    <iframe class="modern-tool-frame modern-subtitles-frame" title="Subtitle workspace"></iframe>
    <iframe class="modern-tool-frame modern-prompt-frame" title="Prompt Lab" src="/prompt-lab?embedded=modern"></iframe>
  `;
  shell.append(toolDeck);

  const jobSettingsPanel = document.createElement("section");
  jobSettingsPanel.className = "modern-job-settings";
  jobSettingsPanel.setAttribute("aria-label", "Current job settings");
  shell.append(jobSettingsPanel);

  for (const link of document.querySelectorAll('.modern-sidebar a[href], .modern-topbar a[href]')) {
    link.addEventListener("click", event => {
      event.preventDefault();
      const destination = new URL(link.getAttribute("href"), window.location.origin);
      window.location.assign(`${destination.pathname}${destination.search}${destination.hash}`);
    });
  }

  const viewMeta = {
    overview: ["Active job", "Translation overview"],
    setup: ["Create", "New translation"],
    jobs: ["Library", "Saved jobs"],
    subtitles: ["Current job", "Subtitles"],
    prompt: ["Translation tools", "Prompt Lab"],
    settings: ["Current job", "Settings"],
  };
  let pendingOverview = false;
  let recentJobs = [];
  let supportingContextOpen = false;
  const openActionMenus = new Set();
  let characterSheetScroll = null;

  function renderJobSettings(job) {
    if (!jobSettingsPanel) return;
    if (!job) {
      jobSettingsPanel.innerHTML = '<div class="panel modern-settings-empty">Select a job to inspect its settings.</div>';
      return;
    }
    const settings = job.settings || {};
    const rows = [
      ["Translation", `${settings.source_language || "Source"} → ${settings.target_language || "Target"}`],
      ["Model", settings.model || "Not recorded"],
      ["Endpoint", settings.base_url || "Not recorded"],
      ["Batch size", settings.batch_size ?? "Default"],
      ["Structured context", settings.structured_context === false ? "Off" : "On"],
      ["Visual scene context", settings.visual_scene_context ? "On" : "Off"],
      ["Visual doubt resolution", settings.visual_resolution ? "On" : "Off"],
      ["Temperature", settings.temperature ?? "Default"],
    ];
    jobSettingsPanel.innerHTML = `
      <section class="panel modern-settings-card">
        <div class="modern-settings-intro"><div><span>Configuration snapshot</span><h2>Settings used by this job</h2></div><p>These values were captured when the translation started.</p></div>
        <dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(String(label))}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}</dl>
        <div class="modern-settings-note"><strong>Prompt Lab is shared.</strong><span>Prompt and runtime defaults apply to new jobs and supported resume operations. This snapshot remains unchanged.</span></div>
      </section>`;
  }

  function syncJobTabs() {
    const workspaceTab = topbar.querySelector("[data-modern-workspace]");
    const workspaceLink = overviewPanel.querySelector("a[href^='/review/']");
    const subtitlesFrame = toolDeck.querySelector(".modern-subtitles-frame");
    if (workspaceTab) {
      workspaceTab.disabled = !workspaceLink;
      workspaceTab.setAttribute("aria-disabled", String(!workspaceLink));
      if (workspaceLink) {
        localStorage.setItem("ai-subcontext-modern-workspace", workspaceLink.href);
        const embeddedUrl = new URL(workspaceLink.href);
        embeddedUrl.searchParams.delete("from");
        embeddedUrl.searchParams.set("embedded", "modern");
        if (subtitlesFrame.src !== embeddedUrl.href) subtitlesFrame.src = embeddedUrl.href;
      }
    }
  }

  function openCharacterSheet(card) {
    const detailDialog = document.getElementById("detail-dialog");
    const detailTitle = document.getElementById("detail-dialog-title");
    const detailBody = document.getElementById("detail-dialog-body");
    if (!detailDialog || !detailTitle || !detailBody) return;
    const name = card.dataset.characterName || "Character";
    const role = card.dataset.characterRole || "Role not established yet";
    const gender = card.dataset.characterGender || "Unknown";
    const aliases = JSON.parse(card.dataset.characterAliases || "[]");
    detailTitle.textContent = name;
    detailBody.innerHTML = "";
    const sheet = document.createElement("article");
    sheet.className = "modern-character-sheet-detail";
    const identity = document.createElement("div");
    identity.className = "modern-character-sheet-identity";
    const heading = document.createElement("h3");
    heading.textContent = name;
    const genderTag = document.createElement("span");
    genderTag.textContent = gender;
    identity.append(heading, genderTag);
    const roleBlock = document.createElement("section");
    roleBlock.innerHTML = "<span>Role in story</span>";
    const roleCopy = document.createElement("p");
    roleCopy.textContent = role;
    roleBlock.append(roleCopy);
    sheet.append(identity, roleBlock);
    if (aliases.length) {
      const aliasBlock = document.createElement("section");
      aliasBlock.innerHTML = "<span>Known aliases</span>";
      const aliasList = document.createElement("div");
      aliasList.className = "modern-character-sheet-aliases";
      for (const alias of aliases) {
        const chip = document.createElement("span");
        chip.textContent = alias;
        aliasList.append(chip);
      }
      aliasBlock.append(aliasList);
      sheet.append(aliasBlock);
    }
    detailBody.append(sheet);
    characterSheetScroll = {
      page: window.scrollY,
      cast: card.closest(".context-section")?.scrollTop || 0,
    };
    document.body.style.position = "fixed";
    document.body.style.top = `-${characterSheetScroll.page}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    detailDialog.dataset.modernCharacterSheet = "true";
    detailDialog.showModal();
  }

  document.getElementById("detail-dialog")?.addEventListener("close", event => {
    const dialog = event.currentTarget;
    if (dialog.dataset.modernCharacterSheet !== "true" || !characterSheetScroll) return;
    delete dialog.dataset.modernCharacterSheet;
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.left = "";
    document.body.style.right = "";
    document.body.style.width = "";
    window.scrollTo({ top: characterSheetScroll.page, behavior: "auto" });
    const scroller = overviewPanel.querySelector(".modern-cast-panel > .context-section");
    if (scroller) scroller.scrollTop = characterSheetScroll.cast;
    characterSheetScroll = null;
    requestAnimationFrame(() => {
      if (document.activeElement?.closest?.(".modern-cast-panel .tile-fixed")) document.activeElement.blur();
    });
  });

  function setHeaderForJob(job) {
    if (!job) return;
    const title = String(job.title || job.filename || "Translation job");
    topbar.querySelector("[data-modern-kicker]").textContent = `${job?.settings?.source_language || "Source"} → ${job?.settings?.target_language || "Target"}`;
    topbar.querySelector("[data-modern-title]").textContent = title;
  }

  function setView(nextView, updateHash = true) {
    let view = nextView;
    if ((view === "overview" || view === "subtitles") && overviewPanel.classList.contains("hidden")) {
      pendingOverview = true;
      view = "jobs";
    } else if (view === "overview") {
      pendingOverview = false;
    } else if (updateHash) {
      pendingOverview = false;
    }
    document.body.dataset.modernView = view;
    const [kicker, title] = viewMeta[view] || viewMeta.jobs;
    topbar.querySelector("[data-modern-kicker]").textContent = kicker;
    topbar.querySelector("[data-modern-title]").textContent = title;
    if (view === "overview") {
      const visibleJobId = overviewPanel.querySelector("[data-action][data-id]")?.dataset.id;
      const visibleJob = recentJobs.find(job => job.id === visibleJobId);
      if (visibleJob) setHeaderForJob(visibleJob);
    }
    for (const button of document.querySelectorAll("[data-modern-view]")) {
      const active = button.dataset.modernView === view;
      button.classList.toggle("is-active", active);
      if (button.getAttribute("role") === "tab") button.setAttribute("aria-selected", String(active));
    }
    if (updateHash) {
      const nextUrl = new URL(window.location.href);
      nextUrl.hash = view;
      history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  document.addEventListener("click", event => {
    const trigger = event.target.closest("button[data-modern-view], a[data-modern-view]");
    if (!trigger) return;
    event.preventDefault();
    setView(trigger.dataset.modernView);
  });

  async function selectJob(jobId) {
    window.modernSelectedJobId = jobId;
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) throw new Error("Could not load the selected job.");
    const job = await response.json();
    setHeaderForJob(job);
    renderJobSettings(job);
    if (job.session_context && typeof window.renderContext === "function") {
      overviewPanel.innerHTML = window.renderContext(job);
      overviewPanel.classList.remove("hidden");
      enhanceOverview();
      window.refreshVisionRails?.(overviewPanel);
      setView("overview");
    } else {
      window.location.href = `/review/${encodeURIComponent(jobId)}?from=modern`;
    }
  }

  async function refreshRecentJobs() {
    const target = sidebar.querySelector("[data-modern-recent-jobs]");
    try {
      const response = await fetch("/api/jobs?view=summary");
      if (!response.ok) throw new Error("Could not load jobs.");
      const jobs = await response.json();
      recentJobs = jobs;
      const visibleJobId = overviewPanel.querySelector("[data-action][data-id]")?.dataset.id;
      const visibleJob = jobs.find(job => job.id === visibleJobId);
      if (visibleJob && document.body.dataset.modernView === "overview") setHeaderForJob(visibleJob);
      if (visibleJob) renderJobSettings(visibleJob);
      target.innerHTML = "";
      if (!jobs.length) {
        target.innerHTML = `<div class="modern-recent-loading">No saved jobs yet.</div>`;
        return;
      }
      for (const job of jobs.slice(0, 8)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "modern-recent-job";
        button.dataset.jobId = job.id;
        button.title = job.title || job.filename || "Open job";
        const title = document.createElement("strong");
        title.textContent = job.title || job.filename || "Untitled job";
        const meta = document.createElement("span");
        const translated = Number(job.translated_count ?? job.translated_line_count ?? job.translated_lines?.length ?? 0);
        const source = Number(job.source_count ?? job.source_line_count ?? job.original_lines?.length ?? 0);
        meta.textContent = `${translated}/${source} · ${job.status || "saved"}`;
        button.append(title, meta);
        target.append(button);
      }
    } catch (error) {
      target.innerHTML = `<button type="button" class="modern-recent-retry">Could not load jobs · Retry</button>`;
    }
  }

  sidebar.addEventListener("click", event => {
    const jobButton = event.target.closest("[data-job-id]");
    if (jobButton) {
      void selectJob(jobButton.dataset.jobId).catch(() => setView("jobs"));
      return;
    }
    if (event.target.closest(".modern-recent-retry")) void refreshRecentJobs();
  });

  document.addEventListener("click", event => {
    const characterCard = event.target.closest(".modern-cast-panel .tile-fixed");
    if (characterCard) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openCharacterSheet(characterCard);
      return;
    }
    const workspaceLink = event.target.closest("a[href^='/review/']");
    if (workspaceLink) {
      event.preventDefault();
      window.location.assign(workspaceLink.href);
      return;
    }
    const moreSummary = event.target.closest(".job-more-actions > summary");
    if (moreSummary) {
      event.preventDefault();
      const menu = moreSummary.parentElement;
      const jobId = menu.dataset.jobMore || "active";
      menu.open = !menu.open;
      if (menu.open) openActionMenus.add(jobId);
      else openActionMenus.delete(jobId);
      return;
    }
    const supportingSummary = event.target.closest(".modern-supporting-context > summary");
    if (supportingSummary) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const supporting = supportingSummary.parentElement;
      const anchorTop = supportingSummary.getBoundingClientRect().top;
      const previousOverflowAnchor = document.documentElement.style.overflowAnchor;
      document.documentElement.style.overflowAnchor = "none";
      supporting.open = !supporting.open;
      supportingContextOpen = supporting.open;
      supportingSummary.blur();
      const pinDisclosure = () => {
        const delta = supportingSummary.getBoundingClientRect().top - anchorTop;
        if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: "auto" });
      };
      pinDisclosure();
      requestAnimationFrame(pinDisclosure);
      setTimeout(pinDisclosure, 50);
      setTimeout(pinDisclosure, 150);
      setTimeout(() => {
        pinDisclosure();
        document.documentElement.style.overflowAnchor = previousOverflowAnchor;
      }, 320);
      return;
    }
  });

  function enhanceOverview() {
    if (overviewPanel.classList.contains("hidden")) {
      if (document.body.dataset.modernView === "overview") setView("jobs", false);
      return;
    }
    if (pendingOverview) {
      pendingOverview = false;
      setView("overview", false);
    }
    const visibleJobId = overviewPanel.querySelector("[data-action][data-id]")?.dataset.id;
    const visibleJob = recentJobs.find(job => job.id === visibleJobId);
    if (visibleJob && document.body.dataset.modernView === "overview") setHeaderForJob(visibleJob);
    const details = overviewPanel.querySelector(".active-context-details");
    if (details && !details.open) details.open = true;
    details?.setAttribute("id", "modern-context");
    overviewPanel.querySelector(".vision-timeline")?.setAttribute("id", "modern-evidence");
    const editButton = overviewPanel.querySelector('[data-action="edit"]');
    if (editButton && editButton.parentElement !== details) {
      editButton.classList.add("modern-reveal-action");
      details?.append(editButton);
    }
    const logButton = overviewPanel.querySelector('[data-action="logs"]');
    if (logButton && !logButton.classList.contains("modern-log-button")) {
      logButton.innerHTML = `<span aria-hidden="true">▤</span><span>Logs</span>`;
      logButton.classList.add("modern-log-button");
    }
    syncJobTabs();
    const moreMenu = overviewPanel.querySelector(".job-more-actions[data-job-more]");
    if (moreMenu && openActionMenus.has(moreMenu.dataset.jobMore)) moreMenu.open = true;
    const panelHead = overviewPanel.querySelector(":scope > .context-card > .panel-head");
    const status = panelHead?.querySelector(":scope > .badge");
    const meta = panelHead?.querySelector(".job-meta");
    if (status && meta && status.parentElement !== meta) meta.append(status);

    const snapshot = details?.querySelector(":scope > .active-context-details-body > .context-card");
    if (snapshot && !snapshot.classList.contains("modern-context-composed")) {
      snapshot.classList.add("modern-context-composed");
      const sections = [...snapshot.children];
      const named = label => sections.find(item => item.querySelector(":scope > .mini-eyebrow")?.textContent.trim() === label);
      const characters = named("Characters");
      const scene = named("Scene");
      const supporting = sections.filter(item => item !== scene && item !== characters);

      const focus = document.createElement("section");
      focus.className = "modern-live-context";
      focus.innerHTML = `<div class="modern-section-heading"><div><span>Live context</span><h2>What is happening now</h2></div><span class="modern-live-indicator">Current scene</span></div>`;
      if (scene) focus.append(scene);

      const cast = document.createElement("aside");
      cast.className = "modern-cast-panel";
      cast.innerHTML = `<div class="modern-section-heading"><div><span>Character sheets</span><h2>People in context</h2></div></div>`;
      if (characters) cast.append(characters);

      const characterGrid = cast.querySelector(".grid-characters");
      if (characterGrid) {
        const seen = new Set();
        for (const card of [...characterGrid.children]) {
          const title = card.querySelector(".tile-title-text");
          const normalized = String(title?.textContent || "").replace(/^\s*:\s*/, "").trim();
          const key = normalized.toLocaleLowerCase();
          if (!normalized || seen.has(key)) {
            card.remove();
            continue;
          }
          seen.add(key);
          title.textContent = normalized;
          const copy = card.querySelector(".tile-copy");
          const gender = card.querySelector(".tooltip-tag")?.textContent.trim() || "Unknown";
          if (copy) {
            const normalizedCopy = String(copy.textContent || "").replace(/^\s*:\s*/, "").trim();
            copy.textContent = normalizedCopy || "Role not established yet";
          }
          const chips = card.querySelector(".chip-row");
          const aliases = chips ? [...chips.children].map(chip => chip.textContent.trim()).filter(Boolean) : [];
          if (chips) {
            chips.dataset.aliasCount = String(chips.children.length);
            chips.dataset.aliasLabel = chips.children.length === 1 ? "alias" : "aliases";
            chips.setAttribute("aria-label", `Aliases for ${normalized}`);
          }
          card.querySelector(".tile-actions")?.remove();
          card.dataset.characterName = normalized;
          card.dataset.characterRole = copy?.textContent.trim() || "Role not established yet";
          card.dataset.characterGender = gender;
          card.dataset.characterAliases = JSON.stringify(aliases);
          card.tabIndex = 0;
          card.setAttribute("role", "button");
          card.setAttribute("aria-label", `Open character sheet for ${normalized}`);
        }
      }

      const stage = document.createElement("div");
      stage.className = "modern-context-stage";
      stage.append(focus, cast);

      const more = document.createElement("details");
      more.className = "modern-supporting-context";
      more.open = supportingContextOpen;
      more.addEventListener("toggle", () => {
        supportingContextOpen = more.open;
      });
      more.innerHTML = `<summary><div><strong>Story context & terminology</strong><span>Premise, tone, style, glossary and unresolved ambiguities</span></div><span class="modern-disclosure">Show</span></summary><div class="modern-supporting-grid"></div>`;
      const moreBody = more.querySelector(".modern-supporting-grid");
      supporting.forEach(item => moreBody.append(item));
      snapshot.append(stage, more);
    }
  }

  document.addEventListener("toggle", event => {
    if (event.target.matches?.(".modern-supporting-context")) supportingContextOpen = event.target.open;
  }, true);

  overviewPanel.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".modern-cast-panel .tile-fixed");
    if (!card) return;
    event.preventDefault();
    openCharacterSheet(card);
  });

  const observer = new MutationObserver(() => enhanceOverview());
  observer.observe(overviewPanel, { childList: true, subtree: true });
  enhanceOverview();
  void refreshRecentJobs();
  const hashView = window.location.hash.slice(1);
  setView(["overview", "subtitles", "prompt", "settings", "setup", "jobs"].includes(hashView) ? hashView : "overview", false);
  const requestedJobId = new URLSearchParams(window.location.search).get("job");
  if (requestedJobId && hashView !== "setup" && hashView !== "jobs") {
    void selectJob(requestedJobId).catch(() => setView("jobs"));
  }
})();
