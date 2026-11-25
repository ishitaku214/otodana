"use strict";

const downloadLimit = 128_000_000;
const downloadConnectionKey = "otodana-download-connection";
const pcDownloadOrigin = "http://127.0.0.1:8787";
const pcDownloadUnavailable = "PCの取得機能に接続できません。「Windows版を開く.cmd」を開き、ブラウザに接続の確認が出たら許可してください。";

class DownloadConnectionError extends Error {}

function readDownloadConnection() {
  try {
    return JSON.parse(localStorage.getItem(downloadConnectionKey)) ?? {};
  } catch {
    return {};
  }
}

function downloadServerOrigin(value) {
  let server;
  try {
    server = new URL(value.trim());
  } catch {
    throw new DownloadConnectionError("取得サーバーのURLを入力してください。");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"];
  const local = loopback.includes(server.hostname) && loopback.includes(location.hostname);
  if (server.username || server.password || server.pathname !== "/" || server.search || server.hash ||
      (server.protocol !== "https:" && !(local && server.protocol === "http:"))) {
    throw new DownloadConnectionError("取得サーバーのHTTPSアドレスを入力してください。");
  }
  return server.origin;
}

async function receiveMedia(response, onProgress) {
  function rejectResponse(message) {
    response.body?.cancel().catch(() => {});
    throw new Error(message);
  }
  if (!response.ok || response.status === 206) {
    rejectResponse("取得サーバーからファイル全体を受け取れませんでした。");
  }
  const mime = response.headers.get("Content-Type") ?? "";
  if (!/^(audio\/mpeg|video\/mp4)(?:;|$)/i.test(mime)) rejectResponse("取得サーバーの応答が動画・音声ファイルではありません。");
  const total = Number(response.headers.get("Content-Length"));
  const tooLarge = "128MBを超えています。ライブラリの「♪」から「端末のファイルを選ぶ」を押すと、保存済みファイルを取り込めます。";
  if (total > downloadLimit) rejectResponse(tooLarge);
  if (!response.body) throw new Error("ファイルを受信できませんでした。");
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastUpdate = 0;
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (done) break;
      loaded += chunk.value.byteLength;
      if (loaded > downloadLimit) throw new Error(tooLarge);
      chunks.push(chunk.value);
      const time = performance.now();
      if (time - lastUpdate > 140) {
        onProgress(loaded, total);
        lastUpdate = time;
      }
    }
    onProgress(loaded, loaded);
  } finally {
    if (!done) reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new Blob(chunks, { type: mime });
}

function waitForDownloadRetry(signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, 2500);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

async function waitForRenderServer(origin, signal, showProgress) {
  const deadline = Date.now() + 120_000;
  const notice = setTimeout(() => showProgress("取得サーバーを起動中…"), 750);
  try {
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const check = new AbortController();
      const abortCheck = () => check.abort();
      signal.addEventListener("abort", abortCheck, { once: true });
      const timeout = setTimeout(abortCheck, Math.min(15_000, deadline - Date.now()));
      try {
        const response = await fetch(origin + "/health", {
          signal: check.signal, credentials: "omit", cache: "no-store", redirect: "error",
        });
        if (response.ok && response.headers.get("Content-Type")?.startsWith("application/json")) {
          if ((await response.json())?.ok === true) return;
        } else {
          response.body?.cancel().catch(() => {});
        }
      } catch {
        // Render can return a loading page or a CORS failure while the service starts.
        signal.throwIfAborted();
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abortCheck);
      }
      if (Date.now() < deadline) await waitForDownloadRetry(signal);
    }
    signal.throwIfAborted();
    throw new DownloadConnectionError("取得サーバーが約2分以内に応答しませんでした。「登録先の稼働ページ」で状態を確認してください。");
  } finally {
    clearTimeout(notice);
  }
}

async function createDownloadRequest(connection, signal, showProgress) {
  if (!connection.origin || !connection.token) throw new DownloadConnectionError("取得サーバーのURLと接続キーを保存してください。");
  const origin = connection.pcLocal ? pcDownloadOrigin : downloadServerOrigin(connection.origin);
  const networkOptions = connection.pcLocal ? { targetAddressSpace: "loopback" } : {};
  if (new URL(origin).hostname.endsWith(".onrender.com")) await waitForRenderServer(origin, signal, showProgress);
  return async (path, { method = "GET", body, requestSignal = signal, expectedStatuses = [] } = {}) => {
    let response;
    try {
      response = await fetch(origin + path, {
        ...networkOptions,
        method, body: body ? JSON.stringify(body) : undefined, signal: requestSignal,
        headers: { Authorization: "Bearer " + connection.token, ...(body && { "Content-Type": "application/json" }) },
        credentials: "omit", cache: "no-store", redirect: "error",
      });
    } catch (error) {
      if (requestSignal.aborted) throw error;
      throw new DownloadConnectionError(connection.pcLocal ? pcDownloadUnavailable :
        "取得サーバーに接続できません。「接続を確認」または「登録先の稼働ページ」から状況を確認してください。");
    }
    if (response.status === 401) {
      throw new DownloadConnectionError(connection.pcLocal ? "PCの取得機能が再起動しました。もう一度保存を試してください。" :
        "接続キーが一致しません。Renderの管理画面で接続キーを確認してください。");
    }
    if (!response.ok && !expectedStatuses.includes(response.status)) {
      const details = await response.json().catch(() => ({}));
      throw new Error(typeof details?.message === "string" ? details.message : "取得サーバーでエラーが発生しました。");
    }
    return response;
  };
}

async function readPCDownloadConnection(signal) {
  try {
    const response = await fetch(pcDownloadOrigin + "/api/pc-download/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      targetAddressSpace: "loopback", credentials: "omit", cache: "no-store", redirect: "error",
    });
    if (response.ok) {
      const { token } = await response.json();
      if (typeof token === "string" && /^[\w-]{43}$/.test(token)) return { origin: pcDownloadOrigin, token, pcLocal: true };
    }
  } catch (error) {
    if (signal.aborted) throw error;
  }
  throw new DownloadConnectionError(pcDownloadUnavailable);
}

async function downloadVideoPage(url, format, request, signal, showProgress) {
  showProgress("配信元に接続しています…");
  const base = "/api/downloads";
  const created = await request(base, { method: "POST", body: { url, format } });
  const { id } = await created.json();
  if (typeof id !== "string" || !/^[a-f\d-]{36}$/.test(id)) throw new Error("取得サーバーの応答を確認できませんでした。");
  const job = base + "/" + id;
  try {
    for (;;) {
      const status = await (await request(job)).json();
      if (status.state === "error") throw new Error(status.message || "動画を取得できませんでした。");
      if (status.state === "ready") {
        showProgress("端末に転送しています…");
        const response = await request(job + "/file");
        const blob = await receiveMedia(response, (loaded, total) => {
          const percent = total ? Math.min(100, Math.floor(loaded / total * 100)) : undefined;
          const detail = percent === undefined ? (loaded / 1_000_000).toFixed(1) + " MB" : percent + "%";
          showProgress("端末に転送中 · " + detail, percent);
        });
        return { blob, name: (status.title || "ダウンロード") + "." + format };
      }
      if (status.state === "downloading") {
        const percent = Number.isFinite(status.percent) ? Math.floor(status.percent) : undefined;
        showProgress(percent === undefined ? "配信元から取得中…" : "配信元から取得中 · " + percent + "%", percent);
      } else if (status.state === "converting") {
        showProgress(format.toUpperCase() + "に変換しています…");
      } else {
        throw new Error("取得状態を確認できませんでした。");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      signal.throwIfAborted();
    }
  } finally {
    const cleanup = new AbortController();
    const timeout = setTimeout(() => cleanup.abort(), 8000);
    try { await request(job, { method: "DELETE", requestSignal: cleanup.signal }); }
    catch { /* The server also discards expired results. */ }
    finally { clearTimeout(timeout); }
  }
}

function displayDownloadSize(bytes) {
  const megabytes = bytes >= 1_000_000;
  const amount = new Intl.NumberFormat("ja", { maximumFractionDigits: 2 }).format(bytes / (megabytes ? 1_000_000 : 1000));
  return amount + (megabytes ? " MB" : " KB");
}

function setupDownloadSettings() {
  const find = (id) => document.getElementById(id);
  const config = find("download-config");
  const serverField = find("download-server");
  const tokenField = find("download-token");
  const saveConfig = find("download-config-save");
  const checkConnection = find("download-check");
  const healthLink = find("download-health-link");
  const progress = find("download-config-progress");
  const message = find("download-config-message");
  let checking;

  function updateHealthLink() {
    try {
      healthLink.href = downloadServerOrigin(serverField.value) + "/health";
      healthLink.hidden = false;
    } catch {
      healthLink.removeAttribute("href");
      healthLink.hidden = true;
    }
  }
  function connectionFields() {
    const origin = downloadServerOrigin(serverField.value);
    const token = tokenField.value.trim();
    if (token.length < 24) throw new DownloadConnectionError("取得サーバーの接続キーを入力してください。");
    return { origin, token };
  }
  serverField.addEventListener("input", updateHealthLink);

  function toggleChecking(running) {
    for (const element of [serverField, tokenField, saveConfig, checkConnection]) element.disabled = running;
    progress.hidden = !running;
  }

  function cancelCheck() {
    checking?.abort();
    checking = null;
    toggleChecking(false);
  }

  for (const opener of document.querySelectorAll('[aria-controls="download-config"]')) {
    opener.addEventListener("click", () => {
      if (config.open) return;
      const connection = readDownloadConnection();
      serverField.value = connection.origin || "";
      tokenField.value = connection.token || "";
      message.textContent = "";
      updateHealthLink();
      config.showModal();
    });
  }
  find("download-config-close").addEventListener("click", () => {
    cancelCheck();
    config.close();
  });
  config.addEventListener("cancel", cancelCheck);
  saveConfig.addEventListener("click", () => {
    try {
      localStorage.setItem(downloadConnectionKey, JSON.stringify(connectionFields()));
      message.textContent = "取得サーバーの設定を保存しました。";
    } catch (error) {
      message.textContent = error.message;
    }
  });
  checkConnection.addEventListener("click", async () => {
    if (checking) return;
    const controller = new AbortController();
    const { signal } = controller;
    checking = controller;
    toggleChecking(true);
    const showStatus = (text) => {
      if (checking === controller) message.textContent = text;
    };
    showStatus("取得サーバーの応答を確認しています…");
    try {
      if (!/^https?:$/.test(location.protocol)) {
        throw new Error("この機能はGitHub Pagesの公開ページか、Windowsのローカルサーバーで使えます。");
      }
      const request = await createDownloadRequest(connectionFields(), signal, showStatus);
      // An empty estimate is rejected after authentication and starts no download.
      const response = await request("/api/downloads/estimate", { method: "POST", body: {}, expectedStatuses: [400] });
      const result = await response.json().catch(() => ({}));
      if (response.status !== 400 || result?.message !== "動画の共有リンクと保存形式を確認してください。") {
        throw new DownloadConnectionError("応答を受け取りましたが、音棚の取得サーバーとして確認できませんでした。");
      }
      showStatus("取得サーバーに接続できました。接続キーも有効です。");
    } catch (error) {
      showStatus(error.message);
    } finally {
      if (checking === controller) {
        checking = null;
        toggleChecking(false);
      }
    }
  });
}

function youtubePreviewUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;

  let id;
  if (url.hostname === "youtu.be") {
    id = url.pathname.match(/^\/([\w-]{11})\/?$/)?.[1];
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(url.hostname)) {
    id = url.pathname === "/watch" ? url.searchParams.get("v")
      : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})\/?$/)?.[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg" : null;
}

async function estimateDownload(item, request) {
  const response = await request("/api/downloads/estimate", {
    method: "POST", body: { url: item.url, format: item.format }, expectedStatuses: [422, 504],
  });
  const estimate = await response.json().catch(() => null);
  if (response.ok && typeof estimate?.title === "string") return estimate;
  if (!response.ok && (estimate?.code === "estimate_unavailable" ||
    (response.status === 504 && estimate?.message === "容量の確認に時間がかかりすぎました。") ||
    (response.status === 422 && estimate?.message === "配信元から取得または変換できませんでした。時間をおいて試してください。"))) {
    return null;
  }
  throw new Error(typeof estimate?.message === "string" ? estimate.message : "動画の容量を確認できませんでした。");
}

function summarizeDownloadSize(items, field) {
  const known = items.filter((item) => Number.isFinite(item.estimate?.[field]));
  if (!known.length) return "確認できません";
  const bytes = known.reduce((total, item) => total + item.estimate[field], 0);
  const approximate = field === "savedBytes" || known.some((item) => item.estimate.approximate);
  const unknown = items.length - known.length;
  return (approximate ? "約 " : "") + displayDownloadSize(bytes)
    + (unknown ? " ＋ " + unknown + "件は不明" : "");
}

function setupMediaDownloads(saveMedia) {
  setupDownloadSettings();
  const find = (id) => document.getElementById(id);
  const dialog = find("download-dialog");
  const list = find("download-rows");
  const template = find("download-row-template");
  const settingsButton = find("download-settings");
  const skipEstimate = find("download-skip-estimate");
  const pcLocal = find("download-pc-local");
  const onWindows = location.origin === pcDownloadOrigin || /^Win/i.test(navigator.userAgentData?.platform ?? navigator.platform);
  find("download-pc-option").hidden = !onWindows;
  pcLocal.checked = onWindows;
  const progress = find("download-progress");
  const estimatePanel = find("download-estimate");
  const estimateNote = find("download-estimate-note");
  const start = find("download-start");
  const confirm = find("download-confirm");
  const message = find("download-message");
  const cancel = find("download-cancel");
  const close = find("download-close");
  const rows = [];
  let nextRowId = 0;
  let job;
  let approval;

  function setRowState(row, state = "", text = "", active = false, percent) {
    row.element.dataset.state = state;
    row.info.hidden = !text;
    row.status.textContent = text;
    row.progress.hidden = !active;
    if (Number.isFinite(percent)) row.progress.value = percent;
    else row.progress.removeAttribute("value");
  }

  function clearPreview(row) {
    row.preview?.abort();
    if (row.image.src.startsWith("blob:")) URL.revokeObjectURL(row.image.src);
    row.image.hidden = true;
    row.image.removeAttribute("src");
  }

  function updatePreview(row) {
    const url = youtubePreviewUrl(row.input.value.trim());
    if (url === row.previewUrl) return;
    row.previewUrl = url;
    clearPreview(row);
    row.cover = null;
    if (!url) return;
    const controller = new AbortController();
    row.preview = controller;
    row.cover = (async () => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          credentials: "omit", referrerPolicy: "no-referrer",
        });
        if (!response.ok || response.headers.get("Content-Type")?.split(";")[0] !== "image/jpeg") return null;
        const cover = await response.blob();
        if (controller.signal.aborted || !cover.size || cover.size > 2_000_000) return null;
        row.image.src = URL.createObjectURL(cover);
        row.image.hidden = false;
        return cover;
      } catch {
        return null;
      }
    })();
  }

  function numberRows() {
    rows.forEach((row, index) => {
      const number = index + 1;
      row.number = number;
      row.element.querySelector(".download-number").textContent = number;
      row.input.setAttribute("aria-label", number + "件目の動画の共有リンク");
      row.element.querySelector(".download-format").setAttribute("aria-label", number + "件目の保存形式");
      row.progress.setAttribute("aria-label", number + "件目の進み具合");
    });
  }

  function removeRow(row) {
    clearPreview(row);
    row.element.remove();
    rows.splice(rows.indexOf(row), 1);
  }

  function ensureBlankRow() {
    if (rows.length && !rows.at(-1).input.value.trim()) return;
    const element = template.content.firstElementChild.cloneNode(true);
    const query = (selector) => element.querySelector(selector);
    const row = {
      element,
      input: query(".download-url"),
      image: query("img"),
      formats: Array.from(element.querySelectorAll('input[type="radio"]')),
      info: query(".download-row-info"),
      status: query(".download-row-status"),
      progress: query(".download-row-progress"),
      previewUrl: null,
    };
    const group = "download-format-" + (++nextRowId);
    for (const format of row.formats) {
      format.name = group;
      format.addEventListener("change", () => setRowState(row));
    }
    row.input.addEventListener("input", () => {
      setRowState(row);
      updatePreview(row);
      ensureBlankRow();
      updateControls();
    });
    row.input.addEventListener("blur", () => {
      if (job || approval || row === rows.at(-1) || row.input.value.trim()) return;
      removeRow(row);
      numberRows();
      updateControls();
    });
    rows.push(row);
    list.append(element);
    numberRows();
  }

  function updateControls() {
    const locked = Boolean(job || approval);
    for (const element of [settingsButton, skipEstimate, pcLocal]) element.disabled = locked;
    for (const row of rows) {
      row.input.disabled = locked;
      for (const format of row.formats) format.disabled = locked || row.saved;
    }
    estimatePanel.hidden = !approval;
    start.hidden = Boolean(approval);
    start.disabled = locked || !rows.some((row) => !row.saved && row.input.value.trim());
    start.textContent = skipEstimate.checked ? "一括保存を開始" : "全件の容量を確認";
    confirm.disabled = Boolean(job);
    cancel.hidden = !job;
  }

  function showProgress(text, percent) {
    progress.hidden = false;
    if (Number.isFinite(percent)) progress.value = percent;
    else progress.removeAttribute("value");
    message.textContent = text;
  }

  function showEstimate(items, direct, excluded) {
    approval = { items, direct, excluded };
    find("download-estimate-source").textContent = summarizeDownloadSize(items, "sourceBytes");
    find("download-estimate-output").textContent = summarizeDownloadSize(items, "savedBytes");
    const unknown = items.filter((item) => !Number.isFinite(item.estimate?.savedBytes)).length;
    const notes = [];
    if (unknown) notes.push(unknown + "件の保存容量は変換後に確定します。上限は1件 " + displayDownloadSize(downloadLimit) + "です。");
    if (excluded) notes.push("エラーの " + excluded + "件は今回の保存対象から外れます。");
    estimateNote.hidden = !notes.length;
    estimateNote.textContent = notes.join(" ");
    confirm.textContent = items.length + "件の一括保存を開始";
  }

  function rowBatch() {
    const items = [];
    let excluded = 0;
    for (const row of rows) {
      const value = row.input.value.trim();
      if (row.saved || !value) continue;
      let url;
      try { url = new URL(value); } catch { /* Invalid rows stay editable. */ }
      if (!url || url.protocol !== "https:" || url.port || url.username || url.password) {
        setRowState(row, "error", "動画のHTTPSリンクを入力してください。");
        excluded++;
        continue;
      }
      setRowState(row);
      items.push({ row, url: url.href, format: row.formats.find((format) => format.checked).value });
    }
    return { items, excluded };
  }

  async function requestFor(direct, signal) {
    if (direct) showProgress("PCの取得機能に接続しています…");
    const connection = direct ? await readPCDownloadConnection(signal) : readDownloadConnection();
    return createDownloadRequest(connection, signal, showProgress);
  }

  async function checkBatch(items, direct, excluded, request, signal) {
    const eligible = [];
    for (const [index, item] of items.entries()) {
      signal.throwIfAborted();
      const { row } = item;
      showProgress((index + 1) + " / " + items.length + " 件の容量を確認しています…", index / items.length * 100);
      setRowState(row, "", "容量を確認中…", true);
      try {
        item.estimate = await estimateDownload(item, request);
        signal.throwIfAborted();
        const { title, sourceBytes, savedBytes, maxSavedBytes, approximate } = item.estimate ?? {};
        const max = maxSavedBytes ?? downloadLimit;
        if (Number.isFinite(savedBytes) && savedBytes > max) {
          throw new Error("保存容量が上限 " + displayDownloadSize(max) + " を超えています。");
        }
        const source = Number.isFinite(sourceBytes) ? (approximate ? "約 " : "") + displayDownloadSize(sourceBytes) : "不明";
        const saved = Number.isFinite(savedBytes) ? "約 " + displayDownloadSize(savedBytes) : "変換後に確定";
        setRowState(row, "", (title ? title + " ／ " : "") + "取得 " + source + " · 保存 " + saved);
        eligible.push(item);
      } catch (error) {
        setRowState(row, "error", signal.aborted ? "容量確認を中止しました。" : error.message);
        if (signal.aborted || error instanceof DownloadConnectionError) throw error;
        excluded++;
      }
    }
    if (!eligible.length) {
      message.textContent = "容量を確認できる項目がありません。各行の表示を確認してください。";
      return;
    }
    message.textContent = "";
    showEstimate(eligible, direct, excluded);
  }

  async function saveBatch(items, excluded, request, signal) {
    let saved = 0;
    let failed = excluded;
    for (const [index, item] of items.entries()) {
      signal.throwIfAborted();
      const { row, url, format } = item;
      showProgress((index + 1) + " / " + items.length + " 件を処理しています…", index / items.length * 100);
      try {
        const input = await downloadVideoPage(url, format, request, signal,
          (text, percent) => setRowState(row, "", text, true, percent));
        const cover = await row.cover;
        signal.throwIfAborted();
        setRowState(row, "", "ライブラリに保存しています…", true);
        cancel.disabled = close.disabled = true;
        const name = (input.name ?? "").replace(/\.[a-z0-9]{1,6}$/i, "")
          .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim();
        await saveMedia(input.blob, (name.slice(0, 180) || "ダウンロード") + "." + format, format, cover);
        row.saved = row.input.readOnly = true;
        saved++;
        setRowState(row, "saved", "端末に保存しました · " + displayDownloadSize(input.blob.size));
      } catch (error) {
        setRowState(row, "error", signal.aborted ? "保存を中止しました。" : error.message);
        if (signal.aborted || error instanceof DownloadConnectionError) throw error;
        failed++;
      } finally {
        cancel.disabled = close.disabled = false;
      }
    }
    message.textContent = saved + "件を端末に保存しました。" + (failed ? "未保存 " + failed + "件" : "");
  }

  async function runTask(operation) {
    if (job) return;
    const controller = new AbortController();
    job = controller;
    const { signal } = controller;
    updateControls();
    message.textContent = "";
    try {
      if (!/^https?:$/.test(location.protocol)) {
        throw new Error("この機能はGitHub Pagesの公開ページか、Windowsのローカルサーバーで使えます。");
      }
      await operation(signal);
    } catch (error) {
      message.textContent = signal.aborted ? "処理を中止しました。保存済みの項目はライブラリに残ります。" : error.message;
    } finally {
      job = null;
      progress.hidden = true;
      updateControls();
      if (dialog.open && approval) confirm.focus();
    }
  }

  find("download-open").addEventListener("click", () => {
    if (dialog.open) return;
    find("add-dialog").close();
    if (!job) {
      for (const row of rows.filter((entry) => entry.saved)) removeRow(row);
      ensureBlankRow();
      numberRows();
      message.textContent = "";
    }
    updateControls();
    dialog.showModal();
  });
  close.addEventListener("click", () => {
    job?.abort();
    approval = null;
    dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (close.disabled) event.preventDefault();
    else {
      job?.abort();
      approval = null;
    }
  });
  cancel.addEventListener("click", () => job?.abort());
  skipEstimate.addEventListener("change", updateControls);
  find("download-estimate-back").addEventListener("click", () => {
    approval = null;
    updateControls();
    start.focus();
  });
  start.addEventListener("click", () => {
    const { items, excluded } = rowBatch();
    if (!items.length) {
      message.textContent = "保存する動画の共有リンクを確認してください。";
      return;
    }
    const direct = pcLocal.checked;
    const skip = skipEstimate.checked;
    runTask(async (signal) => {
      const request = await requestFor(direct, signal);
      if (skip) await saveBatch(items, excluded, request, signal);
      else await checkBatch(items, direct, excluded, request, signal);
    });
  });
  confirm.addEventListener("click", () => {
    if (!approval) return;
    const { items, direct, excluded } = approval;
    approval = null;
    runTask(async (signal) => {
      const request = await requestFor(direct, signal);
      await saveBatch(items, excluded, request, signal);
    });
  });

  ensureBlankRow();
  updateControls();
}
