(() => {
  if (window.location.pathname === "/legacy") return;

  document.body.classList.add("modern-ui");
  const shell = document.querySelector(".console-shell");
  const setupPanel = document.querySelector(".panel-form");
  const overviewPanel = document.getElementById("active-job-card");
  const jobsPanel = document.getElementById("jobs-panel");
  if (!shell || !setupPanel || !overviewPanel || !jobsPanel) return;

  const icon = name => {
    const paths = {
      plus: '<path d="M12 5v14M5 12h14"/>',
      jobs: '<path d="M5 6h2M10 6h9M5 12h2M10 12h9M5 18h2M10 18h9"/>',
      current: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M9 5v14M15 5v14"/>',
      home: '<path d="m3 11 9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
      subtitles: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5"/>',
      prompt: '<path d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5l-.4 3.1a8 8 0 0 0-1.7 1l-2.4-1-2 3.4L5.1 11A7 7 0 0 0 5 12c0 .4 0 .7.1 1L3 14.5 5 18l2.4-1a8 8 0 0 0 1.7 1l.4 3h5l.4-3a8 8 0 0 0 1.7-1l2.4 1 2-3.5-2.1-1.5c.1-.3.1-.6.1-1z"/>',
      file: '<path d="M7 3h7l4 4v14H7zM14 3v5h4M10 13h5M10 17h5"/>',
      video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>',
      image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/>',
      help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 1 1 3.3 2.4c-.7.3-1 .8-1 1.6M12 17h.01"/>',
    };
    return `<svg class="modern-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.file}</svg>`;
  };

  const sidebar = document.createElement("aside");
  sidebar.className = "modern-sidebar";
  sidebar.innerHTML = `
    <div class="modern-brand"><span>AI</span> SubContext</div>
    <nav class="modern-primary-nav" aria-label="Application">
      <button type="button" data-modern-view="setup" title="New translation">${icon("plus")} New translation</button>
      <button type="button" data-modern-view="jobs" title="Saved jobs">${icon("jobs")} Jobs</button>
      <button type="button" data-modern-view="overview" title="Current job">${icon("current")} Current job</button>
    </nav>
    <div class="modern-recent-heading">Recent jobs</div>
    <div class="modern-recent-jobs" data-modern-recent-jobs>
      <div class="modern-recent-loading">Loading jobs…</div>
    </div>
    <div class="modern-sidebar-spacer"></div>
    <nav class="modern-secondary-nav" aria-label="Tools">
      <button type="button" data-modern-view="prompt">${icon("prompt")} Prompt defaults</button>
      <button type="button" data-modern-app-settings>${icon("settings")} Application settings</button>
      <a href="/legacy">Legacy interface</a>
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
      <button type="button" role="tab" data-modern-view="overview">${icon("home")} Overview</button>
      <button type="button" role="tab" class="modern-job-tab" data-modern-view="subtitles" data-modern-workspace disabled>${icon("subtitles")} Subtitles</button>
      <button type="button" role="tab" class="modern-job-tab" data-modern-view="prompt">${icon("prompt")} Prompt Lab</button>
      <button type="button" role="tab" data-modern-view="settings">${icon("settings")} Settings</button>
    </div>
  `;

  shell.before(sidebar);
  shell.prepend(topbar);

  const appSettingsDialog = document.createElement("dialog");
  appSettingsDialog.className = "modern-app-settings-dialog";
  appSettingsDialog.setAttribute("aria-labelledby", "modern-app-settings-title");
  appSettingsDialog.innerHTML = `
    <form method="dialog" class="modern-app-settings-card">
      <div class="modern-app-settings-head">
        <div><div class="modern-kicker">Application</div><h2 id="modern-app-settings-title">Settings</h2></div>
        <button type="submit" class="ghost" aria-label="Close application settings">Close</button>
      </div>
      <fieldset class="modern-theme-options">
        <legend>Appearance</legend>
        <label><input type="radio" name="modern-theme" value="system"><span><strong>System</strong><small>Follow the Windows appearance.</small></span></label>
        <label><input type="radio" name="modern-theme" value="dark"><span><strong>Dark</strong><small>Use the dark studio interface.</small></span></label>
        <label><input type="radio" name="modern-theme" value="light"><span><strong>Light</strong><small>Use a bright neutral interface.</small></span></label>
      </fieldset>
      <p class="modern-settings-scope">Translation models, languages, and context options belong to New Translation or the selected job.</p>
    </form>`;
  document.body.append(appSettingsDialog);

  const THEME_KEY = "ai-subcontext-modern-theme";
  const systemTheme = window.matchMedia("(prefers-color-scheme: light)");
  const storedTheme = localStorage.getItem(THEME_KEY) || "system";
  const applyTheme = theme => {
    const resolved = theme === "system" ? (systemTheme.matches ? "light" : "dark") : theme;
    document.body.dataset.modernTheme = resolved;
    for (const frame of document.querySelectorAll(".modern-tool-deck iframe")) {
      if (frame.contentDocument?.body) frame.contentDocument.body.dataset.modernTheme = resolved;
    }
    for (const option of appSettingsDialog.querySelectorAll('input[name="modern-theme"]')) option.checked = option.value === theme;
  };
  applyTheme(storedTheme);
  systemTheme.addEventListener?.("change", () => {
    if ((localStorage.getItem(THEME_KEY) || "system") === "system") applyTheme("system");
  });
  appSettingsDialog.addEventListener("change", event => {
    const choice = event.target.closest('input[name="modern-theme"]');
    if (!choice) return;
    localStorage.setItem(THEME_KEY, choice.value);
    applyTheme(choice.value);
  });
  sidebar.querySelector("[data-modern-app-settings]")?.addEventListener("click", () => appSettingsDialog.showModal());

  const toolDeck = document.createElement("section");
  toolDeck.className = "modern-tool-deck";
  toolDeck.innerHTML = `
    <iframe class="modern-tool-frame modern-subtitles-frame" title="Subtitle workspace"></iframe>
    <iframe class="modern-tool-frame modern-prompt-frame" title="Prompt Lab" src="/prompt-lab?embedded=modern"></iframe>
  `;
  shell.append(toolDeck);

  for (const frame of toolDeck.querySelectorAll("iframe")) {
    frame.addEventListener("load", () => {
      const theme = document.body.dataset.modernTheme;
      if (theme && frame.contentDocument?.body) frame.contentDocument.body.dataset.modernTheme = theme;
    });
  }

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

  function enhanceSetup() {
    const form = setupPanel.querySelector("#job-form");
    if (!form || form.classList.contains("modern-setup-ready")) return;
    form.classList.add("modern-setup-ready");

    const bannerCopy = setupPanel.querySelector(".panel-banner > div:first-child");
    if (bannerCopy) bannerCopy.innerHTML = '<div class="mini-eyebrow">Create</div><h2>New translation</h2>';

    const stepLabels = ["Files", "Translation", "Engine & context"];
    setupPanel.querySelectorAll(".workflow-steps span").forEach((step, index) => {
      const number = step.querySelector("b")?.outerHTML || `<b>${index + 1}</b>`;
      step.innerHTML = `${number}<em>${stepLabels[index] || step.textContent.trim()}</em>`;
    });

    const relabel = (selector, eyebrow, title) => {
      const section = form.querySelector(selector);
      const label = section?.querySelector(".section-title-row > div");
      if (label) label.innerHTML = `<div class="mini-eyebrow">${eyebrow}</div><h3>${title}</h3>`;
    };
    relabel(".source-section", "Files", "Add translation files");
    relabel(".translation-section", "Translation", "Language and title");
    relabel(".model-section", "Engine", "Translation engine");

    const sourceSection = form.querySelector(".source-section");
    const sourceHeading = sourceSection?.querySelector(".section-title-row");
    if (sourceHeading) sourceHeading.insertAdjacentHTML("afterend", '<p class="modern-section-description">Add the files needed for translation. Only source subtitles are required.</p>');
    const translationHeading = form.querySelector(".translation-section .section-title-row");
    if (translationHeading) translationHeading.insertAdjacentHTML("afterend", '<p class="modern-section-description">Basic information about your project.</p>');
    const engineHeading = form.querySelector(".model-section .section-title-row");
    if (engineHeading) engineHeading.insertAdjacentHTML("afterend", '<p class="modern-section-description">Choose any OpenAI-compatible endpoint and translation model.</p>');

    const dropZone = form.querySelector("#drop-zone");
    if (dropZone) {
      const input = dropZone.querySelector("input");
      const selected = dropZone.querySelector("#selected-file");
      const content = document.createElement("div");
      content.innerHTML = `<span class="modern-drop-icon">${icon("file")}</span><strong>Source subtitles (.srt)</strong><span>Drag and drop your .srt file here, or click to browse</span><span class="modern-browse-button">Browse files</span><small>Only .srt files are supported.</small>`;
      dropZone.replaceChildren();
      if (input) dropZone.append(input);
      while (content.firstChild) dropZone.append(content.firstChild);
      if (selected) dropZone.append(selected);
    }

    const translated = form.querySelector("#translated-drop-zone");
    if (translated) {
      translated.insertAdjacentHTML("afterbegin", `<span class="modern-file-icon">${icon("file")}</span>`);
      translated.insertAdjacentHTML("beforeend", '<span class="modern-file-action">Add file</span>');
    }
    for (const [selector, iconName] of [[".video-source-card > summary", "video"], [".reference-tracks-card > summary", "file"]]) {
      const summary = form.querySelector(selector);
      if (!summary) continue;
      summary.insertAdjacentHTML("afterbegin", `<span class="modern-file-icon">${icon(iconName)}</span>`);
      summary.insertAdjacentHTML("beforeend", '<span class="modern-file-action">Add file</span>');
    }

    const strategyIcons = ["file", "image", "help"];
    form.querySelectorAll(".controls-section .checkbox-card").forEach((card, index) => {
      const copy = card.querySelector(":scope > span");
      if (copy) copy.insertAdjacentHTML("beforebegin", `<span class="modern-strategy-icon">${icon(strategyIcons[index] || "file")}</span>`);
    });

    const modelStatus = form.querySelector("#model-list-status");
    const connectionRow = form.querySelector(".connection-action-row");
    if (modelStatus && connectionRow) {
      const statusGroup = document.createElement("div");
      statusGroup.className = "modern-connection-statuses";
      connectionRow.prepend(statusGroup);
      statusGroup.append(modelStatus);
      const testStatus = connectionRow.querySelector("#connection-test-result");
      if (testStatus) statusGroup.append(testStatus);
      const compactStatus = status => {
        const message = status.textContent.trim();
        if (!message || !/(failed|error|unavailable|refused)/i.test(message) || message === "Endpoint unavailable") return;
        status.title = message;
        status.dataset.fullStatus = message;
        status.textContent = "Endpoint unavailable";
      };
      const statusObserver = new MutationObserver(records => {
        for (const record of records) compactStatus(record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target);
      });
      for (const status of statusGroup.children) {
        compactStatus(status);
        statusObserver.observe(status, { childList: true, characterData: true, subtree: true });
      }
    }

    const launchActions = form.querySelector(".launch-actions");
    if (launchActions && launchActions.parentElement !== form) form.append(launchActions);

    for (const link of form.querySelectorAll('a[href="/prompt-lab"]')) {
      link.href = "#prompt";
      link.dataset.modernView = "prompt";
    }
  }

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
        <div class="modern-settings-note"><strong>Prompt configuration saved with this job.</strong><span>The prompt templates and runtime limits used at creation remain part of this job's settings. A supported resume can explicitly adopt newer Prompt Lab values.</span></div>
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
      const requestedJobId = new URLSearchParams(window.location.search).get("job");
      const visibleJob = jobs.find(job => job.id === visibleJobId)
        || jobs.find(job => job.id === window.modernSelectedJobId)
        || jobs.find(job => job.id === requestedJobId)
        || jobs.find(job => job.session_context && ["processing", "queued", "paused"].includes(job.status));
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

  const observer = new MutationObserver(() => {
    enhanceOverview();
    if (!jobSettingsPanel.innerHTML.trim()) {
      const activeId = overviewPanel.querySelector("[data-action][data-id]")?.dataset.id;
      const activeJob = recentJobs.find(job => job.id === activeId);
      if (activeJob) renderJobSettings(activeJob);
    }
  });
  observer.observe(overviewPanel, { childList: true, subtree: true });
  enhanceOverview();
  enhanceSetup();
  void refreshRecentJobs();
  const hashView = window.location.hash.slice(1);
  setView(["overview", "subtitles", "prompt", "settings", "setup", "jobs"].includes(hashView) ? hashView : "overview", false);
  const requestedJobId = new URLSearchParams(window.location.search).get("job");
  if (requestedJobId && hashView !== "setup" && hashView !== "jobs") {
    void selectJob(requestedJobId).catch(() => setView("jobs"));
  }
})();
