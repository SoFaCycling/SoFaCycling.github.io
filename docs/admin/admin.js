(() => {
  const owner = "SoFaCycling";
  const repo = "SoFaCycling.github.io";
  const branch = "main";
  const apiBase = "https://api.github.com";

  const state = {
    token: "",
    posts: [],
    selectedPost: "",
    currentStorySha: null,
    currentGallerySha: null,
    captions: [],
    movingFile: "",
    dirtyStory: false,
    dirtyCaptions: false,
    needsSync: false,
    needsPublish: false
  };

  const els = {
    token: document.querySelector("#token"),
    connect: document.querySelector("#connect"),
    status: document.querySelector("#status"),
    statusBox: document.querySelector(".admin-status"),
    tabs: document.querySelectorAll(".admin-tab"),
    views: document.querySelectorAll(".admin-view"),
    mode: document.querySelector("#mode"),
    activityId: document.querySelector("#activity-id"),
    createPost: document.querySelector("#create-post"),
    newPostForm: document.querySelector("#new-post-form"),
    postSelect: document.querySelector("#post-select"),
    refreshPosts: document.querySelector("#refresh-posts"),
    story: document.querySelector("#story"),
    saveStoryDraft: document.querySelector("#save-story-draft"),
    uploadStory: document.querySelector("#upload-story"),
    photos: document.querySelector("#photos"),
    uploadPhotos: document.querySelector("#upload-photos"),
    captionList: document.querySelector("#caption-list"),
    saveCaptionsDraft: document.querySelector("#save-captions-draft"),
    uploadCaptions: document.querySelector("#upload-captions"),
    syncPost: document.querySelector("#sync-post"),
    publishPost: document.querySelector("#publish-post")
  };

  function setStatus(message, type = "") {
    const icon = type === "ok" ? "✓" : type === "error" ? "×" : "•";
    els.status.textContent = `${icon} ${message}`;
    els.statusBox.classList.toggle("is-error", type === "error");
    els.statusBox.classList.toggle("is-ok", type === "ok");
  }

  function updateButtonStates() {
    const connected = Boolean(state.token);
    const hasPost = Boolean(state.selectedPost);
    const hasPhotos = Boolean(els.photos.files && els.photos.files.length > 0);
    const hasUnuploadedEdits = state.dirtyStory || state.dirtyCaptions;

    els.createPost.disabled = !connected;
    els.refreshPosts.disabled = !connected;
    els.saveStoryDraft.disabled = !hasPost || !state.dirtyStory;
    els.uploadStory.disabled = !connected || !hasPost || !state.dirtyStory;
    els.uploadPhotos.disabled = !connected || !hasPost || !hasPhotos;
    els.saveCaptionsDraft.disabled = !hasPost || !state.dirtyCaptions;
    els.uploadCaptions.disabled = !connected || !hasPost || !state.dirtyCaptions;
    els.syncPost.disabled = !connected || !hasPost || !state.needsSync || hasUnuploadedEdits;
    els.publishPost.disabled = !connected || !hasPost || (!state.needsSync && !state.needsPublish) || hasUnuploadedEdits;
  }

  function requireToken() {
    if (!state.token) {
      throw new Error("Bitte zuerst den GitHub Token eintragen und verbinden.");
    }
  }

  async function github(path, options = {}) {
    requireToken();

    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${state.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {})
      }
    });

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const detail = data && data.message ? data.message : response.statusText;
      throw new Error(`GitHub API Fehler: ${detail}`);
    }

    return data;
  }

  function toBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function fromBase64Utf8(value) {
    const binary = atob(value.replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function normalizePath(path) {
    return path.replace(/^\/+/, "").replace(/\/+/g, "/");
  }

  function storageKey(type) {
    return `sofacycling-admin:${owner}/${repo}:${branch}:${state.selectedPost}:${type}`;
  }

  function readDraft(type) {
    if (!state.selectedPost) {
      return null;
    }

    try {
      const value = window.localStorage.getItem(storageKey(type));
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  }

  function writeDraft(type, data) {
    if (!state.selectedPost) {
      throw new Error("Bitte zuerst einen Post auswaehlen.");
    }

    try {
      window.localStorage.setItem(storageKey(type), JSON.stringify({
        ...data,
        savedAt: new Date().toISOString()
      }));
    } catch {
      throw new Error("Der Browser konnte den lokalen Entwurf nicht speichern.");
    }
  }

  function clearDraft(type) {
    if (!state.selectedPost) {
      return;
    }

    try {
      window.localStorage.removeItem(storageKey(type));
    } catch {
      // Ignore storage cleanup failures; the committed content remains authoritative.
    }
  }

  async function getContent(path) {
    return github(`/repos/${owner}/${repo}/contents/${encodeURIComponentPath(path)}?ref=${branch}`);
  }

  async function putContent(path, contentBase64, message, sha = null) {
    const body = {
      message,
      content: contentBase64,
      branch
    };

    if (sha) {
      body.sha = sha;
    }

    return github(`/repos/${owner}/${repo}/contents/${encodeURIComponentPath(path)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
  }

  function encodeURIComponentPath(path) {
    return normalizePath(path).split("/").map(encodeURIComponent).join("/");
  }

  async function dispatchWorkflow(workflow, inputs) {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    await github(`/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: branch, inputs })
    });
    return startedAt;
  }

  async function getLatestWorkflowRun(workflow, startedAt) {
    const data = await github(`/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?branch=${branch}&event=workflow_dispatch&per_page=10`);
    const runs = data.workflow_runs || [];
    return runs.find(run => run.created_at >= startedAt) || null;
  }

  async function waitForWorkflow(workflow, startedAt, label) {
    let run = null;

    for (let attempt = 0; attempt < 90; attempt += 1) {
      run = await getLatestWorkflowRun(workflow, startedAt);
      if (run) {
        setStatus(`${label}: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}`);
        if (run.status === "completed") {
          if (run.conclusion !== "success") {
            throw new Error(`${label} ist fehlgeschlagen: ${run.html_url}`);
          }
          return run;
        }
      } else {
        setStatus(`${label}: warte auf Workflow-Start...`);
      }
      await new Promise(resolve => window.setTimeout(resolve, 5000));
    }

    throw new Error(`${label}: Timeout beim Warten auf GitHub Actions.`);
  }

  async function loadPosts() {
    setStatus("Lade Posts...");
    const entries = await getContent("blog/posts");
    state.posts = entries
      .filter(entry => entry.type === "dir")
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a));

    els.postSelect.innerHTML = "";
    for (const slug of state.posts) {
      const option = document.createElement("option");
      option.value = slug;
      option.textContent = slug;
      els.postSelect.append(option);
    }

    if (state.posts.length > 0) {
      state.selectedPost = state.posts[0];
      els.postSelect.value = state.selectedPost;
      await loadSelectedPost();
    } else {
      state.selectedPost = "";
      setStatus("Keine Posts gefunden.", "error");
    }
  }

  async function loadSelectedPost() {
    state.selectedPost = els.postSelect.value;
    if (!state.selectedPost) {
      return;
    }

    await Promise.all([
      loadStory(),
      loadCaptions()
    ]);
    if (state.dirtyStory || state.dirtyCaptions) {
      setStatus(`Post geladen: lokaler Entwurf aktiv`, "ok");
    } else {
      setStatus(`Post geladen: ${state.selectedPost}`, "ok");
    }
  }

  async function loadStory() {
    const path = `blog/posts/${state.selectedPost}/story.md`;
    try {
      const file = await getContent(path);
      state.currentStorySha = file.sha;
      els.story.value = fromBase64Utf8(file.content || "");
      state.dirtyStory = false;
      applyStoryDraft();
    } catch (error) {
      if (error.message.includes("Not Found")) {
        state.currentStorySha = null;
        els.story.value = "";
        state.dirtyStory = false;
        applyStoryDraft();
        return;
      }
      throw error;
    }
  }

  function applyStoryDraft() {
    const draft = readDraft("story");
    if (!draft || typeof draft.value !== "string") {
      return;
    }

    if (draft.value !== els.story.value) {
      els.story.value = draft.value;
      state.dirtyStory = true;
    }
  }

  function parseGallery(content) {
    const captions = [];
    const regex = /!\[((?:\\\]|[^\]])*)\]\(img\/([^)]+)\)\{group="tour"\}/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      captions.push({
        caption: match[1].replace(/\\\]/g, "]"),
        file: match[2]
      });
    }

    return captions;
  }

  async function loadCaptions() {
    const path = `blog/posts/${state.selectedPost}/gallery.qmd`;
    try {
      const file = await getContent(path);
      state.currentGallerySha = file.sha;
      state.captions = parseGallery(fromBase64Utf8(file.content || ""));
    } catch (error) {
      if (error.message.includes("Not Found")) {
        state.currentGallerySha = null;
        state.captions = [];
      } else {
        throw error;
      }
    }

    state.dirtyCaptions = false;
    state.movingFile = "";
    applyCaptionDraft();
    renderCaptions();
    updateButtonStates();
  }

  function applyCaptionDraft() {
    const draft = readDraft("captions");
    if (!draft || !Array.isArray(draft.captions) || state.captions.length === 0) {
      return;
    }

    const currentByFile = new Map(state.captions.map(item => [item.file, item]));
    const seen = new Set();
    const merged = [];

    for (const draftItem of draft.captions) {
      if (!draftItem || !currentByFile.has(draftItem.file)) {
        continue;
      }

      seen.add(draftItem.file);
      merged.push({
        file: draftItem.file,
        caption: typeof draftItem.caption === "string" ? draftItem.caption : ""
      });
    }

    for (const item of state.captions) {
      if (!seen.has(item.file)) {
        merged.push(item);
      }
    }

    if (JSON.stringify(merged) !== JSON.stringify(state.captions)) {
      state.captions = merged;
      state.dirtyCaptions = true;
    }
  }

  function renderCaptions() {
    els.captionList.innerHTML = "";

    if (state.captions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "caption-empty";
      empty.textContent = "Noch keine Galerie vorhanden. Erst Fotos hochladen und synchronisieren.";
      els.captionList.append(empty);
      return;
    }

    if (state.movingFile) {
      els.captionList.append(createDropTarget(0));
    }

    for (let index = 0; index < state.captions.length; index += 1) {
      const item = state.captions[index];
      const row = document.createElement("div");
      row.className = "caption-item";
      row.classList.toggle("is-moving", item.file === state.movingFile);

      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/blog/posts/${encodeURIComponent(state.selectedPost)}/img/${encodeURIComponent(item.file)}`;

      const fieldWrap = document.createElement("div");
      fieldWrap.className = "caption-fields";

      const input = document.createElement("textarea");
      input.value = item.caption;
      input.dataset.file = item.file;
      input.placeholder = "Caption";

      const name = document.createElement("p");
      name.className = "caption-name";
      name.textContent = item.file;

      const actions = document.createElement("div");
      actions.className = "caption-actions";

      const move = document.createElement("button");
      move.type = "button";
      move.textContent = item.file === state.movingFile ? "Abbrechen" : "Verschieben";
      move.classList.toggle("cancel-move", item.file === state.movingFile);
      move.setAttribute("aria-label", `${item.file} verschieben`);
      move.addEventListener("click", () => {
        syncCaptionStateFromForm();
        state.movingFile = item.file === state.movingFile ? "" : item.file;
        renderCaptions();
      });

      actions.append(move);
      fieldWrap.append(name, input, actions);
      row.append(img, fieldWrap);
      els.captionList.append(row);

      if (state.movingFile) {
        els.captionList.append(createDropTarget(index + 1));
      }
    }

    updateButtonStates();
  }

  function createDropTarget(targetIndex) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "caption-drop-target";
    button.textContent = "Hier einsetzen";
    button.addEventListener("click", () => insertMovingCaption(targetIndex));
    return button;
  }

  function insertMovingCaption(targetIndex) {
    syncCaptionStateFromForm();

    const index = state.captions.findIndex(item => item.file === state.movingFile);
    if (index < 0 || targetIndex === index || targetIndex === index + 1) {
      state.movingFile = "";
      renderCaptions();
      return;
    }

    const [item] = state.captions.splice(index, 1);
    const adjustedTarget = targetIndex > index ? targetIndex - 1 : targetIndex;
    state.captions.splice(adjustedTarget, 0, item);
    state.movingFile = "";
    state.dirtyCaptions = true;
    renderCaptions();
  }

  function markCaptionsDirty() {
    syncCaptionStateFromForm();
    state.dirtyCaptions = true;
    updateButtonStates();
  }

  function captionsChangedFromForm() {
    const inputs = els.captionList.querySelectorAll("[data-file]");
    for (const input of inputs) {
      const item = state.captions.find(current => current.file === input.dataset.file);
      if (item && item.caption !== input.value) {
        return true;
      }
    }

    return false;
  }

  function syncCaptionStateFromForm() {
    const inputs = els.captionList.querySelectorAll("[data-file]");
    for (const input of inputs) {
      const item = state.captions.find(current => current.file === input.dataset.file);
      if (item) {
        item.caption = input.value;
      }
    }
  }

  function buildGalleryContent() {
    syncCaptionStateFromForm();
    const lines = ["::: {.gallery}", ""];

    for (const item of state.captions) {
      const caption = item.caption.replace(/\r?\n/g, " ").replace(/]/g, "\\]").trim();
      lines.push(`![${caption}](img/${item.file}){group="tour"}`, "");
    }

    lines.push(":::", "");
    return `${lines.join("\n")}`;
  }

  function saveStoryDraft() {
    if (!state.selectedPost) {
      throw new Error("Bitte zuerst einen Post auswaehlen.");
    }

    writeDraft("story", { value: els.story.value });
    state.dirtyStory = true;
    updateButtonStates();
    setStatus("Story lokal gespeichert.", "ok");
  }

  async function uploadStory() {
    if (!state.selectedPost) {
      throw new Error("Bitte zuerst einen Post auswaehlen.");
    }

    const path = `blog/posts/${state.selectedPost}/story.md`;
    const content = toBase64Utf8(els.story.value);
    const result = await putContent(path, content, "Update story", state.currentStorySha);
    state.currentStorySha = result.content.sha;
    state.dirtyStory = false;
    state.needsSync = true;
    state.needsPublish = true;
    clearDraft("story");
    updateButtonStates();
    setStatus("Story hochgeladen.", "ok");
  }

  function saveCaptionsDraft() {
    if (!state.selectedPost) {
      throw new Error("Bitte zuerst einen Post auswaehlen.");
    }

    syncCaptionStateFromForm();
    writeDraft("captions", { captions: state.captions });
    state.dirtyCaptions = true;
    updateButtonStates();
    setStatus("Galerie lokal gespeichert.", "ok");
  }

  async function uploadCaptions() {
    if (!state.selectedPost) {
      throw new Error("Bitte zuerst einen Post auswaehlen.");
    }

    const path = `blog/posts/${state.selectedPost}/gallery.qmd`;
    const content = toBase64Utf8(buildGalleryContent());
    const result = await putContent(path, content, "Update gallery", state.currentGallerySha);
    state.currentGallerySha = result.content.sha;
    state.dirtyCaptions = false;
    state.movingFile = "";
    state.needsSync = true;
    state.needsPublish = true;
    clearDraft("captions");
    await loadCaptions();
    setStatus("Galerie hochgeladen.", "ok");
  }

  async function uploadPhotos() {
    if (!state.selectedPost) {
      throw new Error("Bitte zuerst einen Post auswaehlen.");
    }

    const files = Array.from(els.photos.files || []);
    if (files.length === 0) {
      throw new Error("Bitte mindestens ein Foto auswaehlen.");
    }

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setStatus(`Lade Foto ${index + 1}/${files.length} hoch: ${file.name}`);
      const buffer = await file.arrayBuffer();
      const path = await uniqueUploadPath(file.name);
      await putContent(path, arrayBufferToBase64(buffer), "Upload photos");
    }

    els.photos.value = "";
    state.needsSync = true;
    state.needsPublish = true;
    updateButtonStates();
    setStatus("Fotos hochgeladen. Jetzt synchronisieren.", "ok");
  }

  async function uniqueUploadPath(fileName) {
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : "";

    for (let counter = 0; counter < 100; counter += 1) {
      const candidate = counter === 0 ? fileName : `${stem}_${counter + 1}${ext}`;
      const path = `blog/posts/${state.selectedPost}/img/${candidate}`;
      try {
        await getContent(path);
      } catch (error) {
        if (error.message.includes("Not Found")) {
          return path;
        }
        throw error;
      }
    }

    throw new Error(`Kein freier Dateiname fuer ${fileName} gefunden.`);
  }

  async function createPost(event) {
    event.preventDefault();
    const mode = els.mode.value;
    const activityId = els.activityId.value.trim();

    if (mode === "static_id" && !activityId) {
      throw new Error("Activity-ID ist fuer diesen Modus erforderlich.");
    }

    const inputs = {
      mode,
      activity_id: mode === "static_id" ? activityId : "",
      trip_name: document.querySelector("#trip-name").value.trim(),
      categories: document.querySelector("#categories").value.trim()
    };

    setStatus("Starte Generate Post...");
    const startedAt = await dispatchWorkflow("generate_post.yml", inputs);
    await waitForWorkflow("generate_post.yml", startedAt, "Generate Post");
    await loadPosts();

    if (activityId) {
      await selectPostByStravaId(activityId);
    }

    setStatus("Post angelegt und geladen.", "ok");
    state.needsSync = false;
    state.needsPublish = true;
    updateButtonStates();
    switchTab("edit");
  }

  async function selectPostByStravaId(activityId) {
    for (const slug of state.posts) {
      const file = await getContent(`blog/posts/${slug}/index.qmd`);
      const content = fromBase64Utf8(file.content || "");
      if (new RegExp(`strava_id:\\s*${activityId}\\b`).test(content)) {
        state.selectedPost = slug;
        els.postSelect.value = slug;
        await loadSelectedPost();
        return;
      }
    }
  }

  async function syncPost() {
    if (!state.selectedPost) {
      throw new Error("Bitte zuerst einen Post auswaehlen.");
    }
    ensureNoUnuploadedEdits();

    setStatus("Starte Synchronisierung...");
    const startedAt = await dispatchWorkflow("generate_post.yml", {
      mode: "sync_post",
      post_slug: state.selectedPost
    });
    await waitForWorkflow("generate_post.yml", startedAt, "Sync Post");
    await loadSelectedPost();
    state.needsSync = false;
    state.needsPublish = true;
    updateButtonStates();
    setStatus("Post synchronisiert.", "ok");
  }

  async function publishPost() {
    if (!state.selectedPost) {
      throw new Error("Bitte zuerst einen Post auswaehlen.");
    }
    ensureNoUnuploadedEdits();

    await syncPost();

    setStatus("Starte Veroeffentlichung...");
    const startedAt = await dispatchWorkflow("publish_post.yml", {
      post_slug: state.selectedPost,
      full_render: "false"
    });
    await waitForWorkflow("publish_post.yml", startedAt, "Publish Post");
    state.needsSync = false;
    state.needsPublish = false;
    updateButtonStates();
    setStatus("Post veroeffentlicht.", "ok");
  }

  function ensureNoUnuploadedEdits() {
    if (state.dirtyStory || state.dirtyCaptions) {
      throw new Error("Bitte Story oder Galerie erst hochladen. Lokal gespeicherte Entwuerfe werden nicht synchronisiert.");
    }
  }

  function switchTab(tab) {
    for (const button of els.tabs) {
      button.classList.toggle("is-active", button.dataset.tab === tab);
    }
    for (const view of els.views) {
      view.classList.toggle("is-active", view.id === `tab-${tab}`);
    }
  }

  async function guarded(handler) {
    try {
      await handler();
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function setBusy(button, busy) {
    button.disabled = busy;
  }

  function bindBusy(button, handler) {
    button.addEventListener("click", () => guarded(async () => {
      setBusy(button, true);
      try {
        await handler();
      } finally {
        setBusy(button, false);
      }
    }));
  }

  els.connect.addEventListener("click", () => guarded(async () => {
    state.token = els.token.value.trim();
    requireToken();
    setStatus("Pruefe GitHub-Zugriff...");
    await github(`/repos/${owner}/${repo}`);
    await loadPosts();
    setStatus("Verbunden", "ok");
    updateButtonStates();
  }));

  els.tabs.forEach(button => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  els.mode.addEventListener("change", () => {
    const needsActivityId = els.mode.value === "static_id";
    els.activityId.disabled = !needsActivityId;
  });

  els.newPostForm.addEventListener("submit", event => guarded(() => createPost(event)));
  els.postSelect.addEventListener("change", () => guarded(loadSelectedPost));
  bindBusy(els.refreshPosts, loadPosts);
  bindBusy(els.saveStoryDraft, saveStoryDraft);
  bindBusy(els.uploadStory, uploadStory);
  bindBusy(els.uploadPhotos, uploadPhotos);
  bindBusy(els.saveCaptionsDraft, saveCaptionsDraft);
  bindBusy(els.uploadCaptions, uploadCaptions);
  bindBusy(els.syncPost, syncPost);
  bindBusy(els.publishPost, publishPost);

  els.activityId.disabled = false;
  els.story.addEventListener("input", () => {
    state.dirtyStory = true;
    updateButtonStates();
  });
  els.photos.addEventListener("change", updateButtonStates);
  els.captionList.addEventListener("input", () => {
    if (captionsChangedFromForm()) {
      markCaptionsDirty();
    }
  });
  updateButtonStates();
})();
