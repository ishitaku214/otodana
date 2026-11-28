"use strict";

const defaultDownloadQuality = "1080";
const downloadConnectionKey = "otodana-download-connection";
const downloadQueueKey = "otodana-download-queue";
const pcDownloadOrigin = "http://127.0.0.1:8787";
const pcDownloadLaunchUrl = "otodana-pc://start";
const pcDownloadStartupWait = 60_000;
const pcDownloadInterrupted = "PCとの接続が途中で切れました。未保存の項目で容量確認またはダウンロードをもう一度お試しください。";

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
  if (!/^(audio\/(?:mpeg|wav)|video\/mp4)(?:;|$)/i.test(mime)) rejectResponse("取得サーバーの応答が動画・音声ファイルではありません。");
  const total = Number(response.headers.get("Content-Length"));
  if (!response.body) throw new Error("ファイルを受信できませんでした。");
  let loaded = 0;
  let lastUpdate = 0;
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      const time = performance.now();
      if (time - lastUpdate > 140) {
        onProgress(loaded, total);
        lastUpdate = time;
      }
      controller.enqueue(chunk);
    },
  }));
  const blob = await new Response(stream, { headers: { "Content-Type": mime } }).blob();
  if (!blob.size || (total > 0 && !response.headers.has("Content-Encoding") && blob.size !== total)) {
    throw new Error("取得サーバーからファイル全体を受け取れませんでした。");
  }
  onProgress(loaded, loaded);
  return blob;
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
      throw new DownloadConnectionError(connection.pcLocal ? pcDownloadInterrupted :
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

async function pcDownloadPermissionDenied() {
  if (location.origin === pcDownloadOrigin || !navigator.permissions) return false;
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      return (await navigator.permissions.query({ name })).state === "denied";
    } catch {
      // Older browsers may only support the original permission name.
    }
  }
  return false;
}

async function readPCDownloadConnection(signal, starting) {
  const deadline = Date.now() + (starting ? pcDownloadStartupWait : 0);
  for (;;) {
    signal.throwIfAborted();
    const timeout = starting ? Math.max(1, Math.min(30_000, deadline - Date.now())) : 30_000;
    let response;
    try {
      response = await fetch(pcDownloadOrigin + "/api/pc-download/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        targetAddressSpace: "loopback", credentials: "omit", cache: "no-store", redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (await pcDownloadPermissionDenied()) {
        throw new DownloadConnectionError("ブラウザが接続をブロックしています。アドレス左のサイト設定で「ローカルネットワーク」または「ループバックネットワーク」へのアクセスを許可してください。");
      }
      if (!starting && error.name === "TimeoutError") {
        throw new DownloadConnectionError("PCの応答がありません。ブラウザに接続の確認が出ていれば「許可」を押し、もう一度接続を確認してください。");
      }
      if (Date.now() < deadline) {
        await waitForDownloadRetry(signal);
        continue;
      }
      throw new DownloadConnectionError("PCの取得機能から応答がありません。起動の確認で「開く」を選ぶか、「Windows版を開く.cmd」を実行してください。");
    }
    const details = response.ok ? await response.json().catch(() => null) : null;
    signal.throwIfAborted();
    if (typeof details?.token === "string" && /^[\w-]{43}$/.test(details.token)) {
      return { origin: pcDownloadOrigin, token: details.token, pcLocal: true };
    }
    throw new DownloadConnectionError("PCの取得機能の応答を確認できません。Windows版を開き直してお試しください。");
  }
}

function downloadItemFields({ url, format, quality }) {
  return { url, format, ...(format === "mp4" && { quality }) };
}

async function downloadVideoPage(item, request, signal, showProgress) {
  const { format } = item;
  showProgress("配信元に接続しています…");
  const base = "/api/downloads";
  const created = await request(base, { method: "POST", body: downloadItemFields(item) });
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
        return { blob, name: (status.title || "ダウンロード") + "." + format, info: status.info };
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

function setupDownloadSettings(setScreenActivity) {
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
    message.toggleAttribute("data-loading", running);
    setScreenActivity("download-connection", running);
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

function youtubePreviewUrl(value, size = "mqdefault") {
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
  return id && /^[\w-]{11}$/.test(id) ? "https://i.ytimg.com/vi/" + id + "/" + size + ".jpg" : null;
}

function youtubeWatchUrl(id) {
  return "https://www.youtube.com/watch?v=" + id;
}

function sourceThumbnailUrl(value) {
  const url = downloadPageUrl(value);
  return url && ["i.ytimg.com", "img.cdn.nimg.jp", "nicovideo.cdn.nimg.jp", "goptim.video.nimg.jp"].includes(url.hostname) ? url.href : null;
}

async function fetchDownloadArtwork(url, signal) {
  if (!url || signal.aborted) return null;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
    });
    const type = response.headers.get("Content-Type")?.split(";")[0];
    if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(type) || Number(response.headers.get("Content-Length")) > 2_000_000) return null;
    const cover = await response.blob();
    return !signal.aborted && cover.size > 0 && cover.size <= 2_000_000 ? cover : null;
  } catch {
    return null;
  }
}

async function squareAudioArtwork(cover, minimumSide = 1) {
  if (!cover) return null;
  const url = URL.createObjectURL(cover);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    const side = Math.min(width, height);
    if (side < minimumSide) return null;
    if (width === height && side <= 768) return cover;
    const outputSide = Math.min(side, 768);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = outputSide;
    canvas.getContext("2d").drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, outputSide, outputSide);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .94));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function audioDownloadArtwork(mediaUrl, preview, signal) {
  const original = await fetchDownloadArtwork(youtubePreviewUrl(mediaUrl, "maxresdefault"), signal);
  const cover = await squareAudioArtwork(original, 320);
  if (cover || signal.aborted) return cover;
  const fallback = await preview;
  return (await squareAudioArtwork(fallback)) ?? fallback;
}

async function estimateDownload(item, request) {
  const response = await request("/api/downloads/estimate", {
    method: "POST", body: downloadItemFields(item), expectedStatuses: [422, 504],
  });
  const estimate = await response.json().catch(() => null);
  if (response.ok && typeof estimate?.title === "string") return estimate;
  if (!response.ok && (estimate?.code === "estimate_unavailable" ||
    (response.status === 504 && estimate?.message === "容量の確認に時間がかかりすぎました。") ||
    (response.status === 422 && estimate?.message === "配信元から取得または変換できませんでした。時間をおいて試してください。"))) {
    return null;
  }
  throw new Error(typeof estimate?.message === "string" ? estimate.message : "動画の容量を確認できませんでした。", { cause: estimate?.code });
}

function selectedDownloadEstimate(item) {
  return item.estimate?.qualities?.[item.quality] ?? item.estimate;
}

function summarizeDownloadSize(items) {
  const known = items.map(selectedDownloadEstimate).filter((estimate) => Number.isFinite(estimate?.savedBytes));
  if (!known.length) return "確認できません";
  const bytes = known.reduce((total, estimate) => total + estimate.savedBytes, 0);
  const unknown = items.length - known.length;
  return "約 " + displayDownloadSize(bytes)
    + (unknown ? " ＋ " + unknown + "件は不明" : "");
}

function downloadPageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.port && !url.username && !url.password) return url;
  } catch {
    // Leave invalid links editable in the download list.
  }
  return null;
}

function isYoutubePlaylist(url) {
  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(url?.hostname)) return false;
  const shareLink = url.hostname === "youtu.be" && /^\/[\w-]{11}\/?$/.test(url.pathname);
  return (shareLink || ["/playlist", "/watch"].includes(url.pathname)) &&
    /^(?:PL|OLAK5uy_|UU|UL|LL|FL|TL|VL)[\w-]{8,150}$/.test(url.searchParams.get("list") ?? "");
}

function defaultFormatForLink(url) {
  const music = isYoutubePlaylist(url) && (url.hostname === "music.youtube.com" || url.searchParams.get("list").startsWith("OLAK5uy_"));
  return music ? "wav" : "mp4";
}

function readDownloadCsv(text) {
  const source = text.replace(/^\uFEFF/, "");
  const fieldPattern = /"((?:[^"]|"")*)"|([^",\r\n]*)/y;
  const records = [];
  let record = [];
  while (fieldPattern.lastIndex < source.length) {
    const field = fieldPattern.exec(source);
    const end = fieldPattern.lastIndex;
    const separator = source[end];
    if (separator && !",\r\n".includes(separator)) {
      throw new Error("CSVの引用符を確認してください。");
    }
    record.push(field[1]?.replace(/""/g, '"') ?? field[2]);
    if (separator !== ",") {
      if (record.some((cell) => cell.trim())) records.push(record);
      record = [];
    }
    if (!separator) break;
    fieldPattern.lastIndex += source.startsWith("\r\n", end) ? 2 : 1;
  }
  if (record.some((cell) => cell.trim())) records.push(record);

  const header = records[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const urlColumn = header.indexOf("url");
  const formatColumn = urlColumn === -1 ? 1 : header.findIndex((cell) => ["保存形式", "形式", "format"].includes(cell));
  if (urlColumn !== -1) records.shift();
  const items = [];
  let skipped = 0;
  for (const cells of records) {
    const url = cells[Math.max(0, urlColumn)]?.trim() ?? "";
    const format = cells[formatColumn]?.trim().toLowerCase() || null;
    if (downloadPageUrl(url) && (format === null || ["mp3", "mp4", "wav"].includes(format))) items.push({ url, format });
    else skipped++;
  }
  return { items, skipped };
}

function setupMediaDownloads(saveMedia, setScreenActivity) {
  setupDownloadSettings(setScreenActivity);
  const find = (id) => document.getElementById(id);
  const dialog = find("download-dialog");
  const destinationLabel = find("download-destination");
  const list = find("download-rows");
  const template = find("download-row-template");
  const settingsButton = find("download-settings");
  const csvButton = find("download-csv-button");
  const csvInput = find("download-csv-input");
  const csvMessage = find("download-csv-message");
  const queueMessage = find("download-queue-message");
  const onWindows = location.origin === pcDownloadOrigin || /^Win/i.test(navigator.userAgentData?.platform ?? navigator.platform);
  const progress = find("download-progress");
  const estimatePanel = find("download-estimate");
  const estimateNote = find("download-estimate-note");
  const start = find("download-start");
  const startActions = find("download-start-actions");
  const more = find("download-more");
  const options = find("download-start-options");
  const skip = find("download-skip");
  const confirm = find("download-confirm");
  const message = find("download-message");
  const cancel = find("download-cancel");
  const close = find("download-close");
  const rows = [];
  let nextRowId = 0;
  let job;
  let approval;
  let destination = null;
  let importing = false;
  let pcConnectedAt = 0;

  function setRowState(row, state = "", text = "", active = false, percent) {
    row.element.dataset.state = state;
    row.info.hidden = !text;
    row.status.textContent = text;
    row.status.toggleAttribute("data-loading", active);
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

  const playlistPreviewObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const row = rows.find((item) => item.element === entry.target);
      if (row) updatePreview(row);
    }
  }, { root: dialog, rootMargin: "100px" }) : null;

  function updatePreview(row) {
    const url = youtubePreviewUrl(row.input.value.trim()) ?? row.sourceThumbnail;
    if (url === row.previewUrl) return;
    row.previewUrl = url;
    clearPreview(row);
    row.cover = null;
    if (!url) return;
    const controller = new AbortController();
    row.preview = controller;
    row.cover = fetchDownloadArtwork(url, controller.signal).then((cover) => {
      if (!cover || controller.signal.aborted) return null;
      row.image.src = URL.createObjectURL(cover);
      row.image.hidden = false;
      return cover;
    });
  }

  function numberRows() {
    rows.forEach((row, index) => {
      const number = index + 1;
      row.number = number;
      row.element.querySelector(".download-number").textContent = number;
      row.input.setAttribute("aria-label", number + "件目の動画の共有リンク");
      for (const field of row.fields) field.setAttribute("aria-label", number + "件目の" + field.placeholder);
      row.element.querySelector(".download-format").setAttribute("aria-label", number + "件目の保存形式");
      row.quality.setAttribute("aria-label", number + "件目の動画画質");
      row.audioFormat.setAttribute("aria-label", number + "件目の音声形式");
      row.clear.setAttribute("aria-label", number + "件目の登録をクリア");
      row.progress.setAttribute("aria-label", number + "件目の進み具合");
    });
  }

  function removeRow(row) {
    playlistPreviewObserver?.unobserve(row.element);
    clearPreview(row);
    row.element.remove();
    rows.splice(rows.indexOf(row), 1);
  }

  function persistRows() {
    const entries = rows.filter((row) => row.input.value.trim())
      .map((row) => ({
        ...downloadItemFields({ url: row.input.value, format: rowFormat(row), quality: row.quality.value }),
        formatChosen: row.formatChosen,
        quality: row.quality.value,
        audioFormat: row.audioFormat.value,
        mediaKind: row.mediaKind,
        info: row.sourceInfo,
        edits: Object.fromEntries(row.fields.filter((field) => "edited" in field.dataset)
          .map((field) => [field.dataset.field, field.value])),
      }));
    try {
      if (entries.length) localStorage.setItem(downloadQueueKey, JSON.stringify(entries));
      else localStorage.removeItem(downloadQueueKey);
      queueMessage.textContent = "";
    } catch {
      queueMessage.textContent = "登録一覧を端末に保存できません。画面を閉じると変更が失われる場合があります。";
    }
  }

  function rowFormat(row) {
    return row.formats[0].checked ? "mp4" : row.audioFormat.value;
  }

  function setRowMediaKind(row, kind) {
    if (kind !== "audio" && kind !== "video") return;
    row.mediaKind = kind;
    if (kind === "audio") row.formats[1].checked = true;
    else if (!row.formatChosen) row.formats[0].checked = true;
  }

  function showQualitySizes(row, sizes) {
    for (const option of row.quality.options) {
      const bytes = sizes?.[option.value]?.savedBytes;
      const size = Number.isFinite(bytes) ? "約" + displayDownloadSize(bytes).replace(" ", "") : "容量不明";
      option.textContent = sizes ? option.dataset.label + "[" + size + "]" : option.dataset.label;
    }
  }

  function applyDownloadInfo(row, info) {
    if (typeof info?.title !== "string" || !info.title) return;
    row.sourceInfo = {};
    for (const field of row.fields) {
      const key = field.dataset.field;
      const value = typeof info[key] === "string" ? info[key].slice(0, 300) : "";
      row.sourceInfo[key] = value;
      if (!("edited" in field.dataset)) field.value = value;
    }
    const thumbnail = sourceThumbnailUrl(info.thumbnail);
    if (thumbnail) row.sourceThumbnail = thumbnail;
    if (row.sourceThumbnail) row.sourceInfo.thumbnail = row.sourceThumbnail;
    setRowMediaKind(row, info.kind);
  }

  function appendRow(url = "", format = null, quality = defaultDownloadQuality, before = null, saved = null) {
    const element = template.content.firstElementChild.cloneNode(true);
    const query = (selector) => element.querySelector(selector);
    const row = {
      element,
      input: query(".download-url"),
      details: query(".download-details"),
      fields: Array.from(element.querySelectorAll("input[data-field]")),
      detailsUrl: downloadPageUrl(url)?.href,
      image: query("img"),
      formatToggle: query(".download-format"),
      audioOnly: query(".download-audio-only"),
      formats: Array.from(element.querySelectorAll('input[type="radio"]')),
      formatChosen: saved?.formatChosen ?? (format !== null),
      quality: query(".download-quality"),
      audioFormat: query(".download-audio-format"),
      info: query(".download-row-info"),
      status: query(".download-row-status"),
      progress: query(".download-row-progress"),
      clear: query(".download-clear"),
      previewUrl: null,
    };
    const group = "download-format-" + (++nextRowId);
    row.input.value = url;
    applyDownloadInfo(row, saved?.info);
    for (const field of row.fields) {
      const previous = saved?.edits?.[field.dataset.field];
      if (typeof previous === "string") {
        field.dataset.edited = "";
        field.value = previous.slice(0, 300);
      }
      field.addEventListener("input", () => {
        field.dataset.edited = "";
        persistRows();
      });
    }
    for (const option of row.quality.options) option.dataset.label = option.textContent;
    if (Array.from(row.quality.options).some((option) => option.value === quality)) row.quality.value = quality;
    const initialFormat = format ?? defaultFormatForLink(downloadPageUrl(url));
    row.audioFormat.value = saved?.audioFormat === "mp3" || initialFormat === "mp3" ? "mp3" : "wav";
    for (const option of row.formats) {
      option.name = group;
      option.checked = option.value === (initialFormat === "mp4" ? "mp4" : "audio");
      option.addEventListener("change", () => changeRowFormat(row));
    }
    setRowMediaKind(row, saved?.mediaKind);
    row.audioFormat.addEventListener("change", () => changeRowFormat(row));
    row.quality.addEventListener("change", () => {
      persistRows();
      if (approval?.rejected.has(row)) {
        changeRowFormat(row);
        return;
      }
      const item = approval?.items.find((entry) => entry.row === row);
      if (item) {
        item.quality = row.quality.value;
        if (item.needsEstimate) {
          changeRowFormat(row);
          return;
        }
        renderEstimateRow(item);
        renderEstimateSummary();
        updateControls();
      } else {
        setRowState(row);
      }
    });
    row.input.addEventListener("input", () => {
      const url = downloadPageUrl(row.input.value.trim());
      if (row.detailsUrl && row.detailsUrl !== url?.href) {
        row.sourceInfo = undefined;
        row.sourceThumbnail = undefined;
        row.mediaKind = undefined;
        row.formatChosen = false;
        for (const field of row.fields) {
          field.value = "";
          delete field.dataset.edited;
        }
      }
      row.detailsUrl = url?.href;
      if (!row.formatChosen) row.formats[defaultFormatForLink(url) === "mp4" ? 0 : 1].checked = true;
      const playlist = isYoutubePlaylist(url);
      setRowState(row, "", playlist ? "プレイリスト内の曲をまとめて読み込みます。" : "");
      showQualitySizes(row);
      updatePreview(row);
      ensureBlankRow();
      persistRows();
      updateControls();
    });
    row.input.addEventListener("blur", () => {
      if (job || approval || row === rows.at(-1) || row.input.value.trim()) return;
      removeRow(row);
      numberRows();
      updateControls();
    });
    row.clear.addEventListener("click", () => {
      if (job || importing || !rows.includes(row)) return;
      if (approval) {
        const index = approval.items.findIndex((item) => item.row === row);
        if (index >= 0) approval.items.splice(index, 1);
        else {
          approval.rejected.delete(row);
          approval.excluded = Math.max(0, approval.excluded - 1);
        }
        if (approval.items.length) renderEstimateSummary();
        else approval = null;
      }
      removeRow(row);
      ensureBlankRow();
      numberRows();
      persistRows();
      updateControls();
    });
    if (before) {
      rows.splice(rows.indexOf(before), 0, row);
      before.element.before(element);
    } else {
      rows.push(row);
      list.append(element);
    }
    return row;
  }

  function ensureBlankRow() {
    if (rows.at(-1)?.input.value.trim() === "") return;
    appendRow();
    numberRows();
  }

  function restoreRows() {
    try {
      const entries = JSON.parse(localStorage.getItem(downloadQueueKey) ?? "[]");
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (typeof entry?.url === "string" && entry.url.trim()) {
          appendRow(entry.url, ["mp3", "wav", "mp4"].includes(entry.format) ? entry.format : null, entry.quality, null, entry);
        }
      }
    } catch {
      queueMessage.textContent = "前回の登録一覧を読み込めませんでした。";
    }
  }

  function updateControls() {
    const locked = Boolean(job || approval || importing);
    const busy = Boolean(job || importing);
    for (const element of [settingsButton, csvButton]) element.disabled = locked;
    for (const row of rows) {
      const editingFormat = !busy && (!approval || approval.items.some((item) => item.row === row) || approval.rejected.has(row));
      const audioOnly = row.mediaKind === "audio";
      row.input.disabled = locked;
      row.details.hidden = !row.detailsUrl;
      row.clear.hidden = !row.input.value.trim();
      for (const field of row.fields) field.disabled = busy;
      row.formatToggle.hidden = audioOnly;
      row.audioOnly.hidden = !audioOnly;
      row.quality.parentElement.hidden = rowFormat(row) !== "mp4";
      row.audioFormat.parentElement.hidden = rowFormat(row) === "mp4";
      row.audioFormat.disabled = !editingFormat;
      row.quality.disabled = !editingFormat;
      row.clear.disabled = busy || !row.input.value.trim();
      for (const format of row.formats) format.disabled = !editingFormat || audioOnly;
    }
    estimatePanel.hidden = !approval;
    startActions.hidden = Boolean(approval);
    start.disabled = more.disabled = skip.disabled = locked || !rows.some((row) => row.input.value.trim());
    if (more.disabled) showOptions(false);
    confirm.disabled = busy || Boolean(approval?.items.some((item) => item.needsEstimate));
    cancel.hidden = !job;
  }

  function showOptions(open) {
    options.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
  }

  function showProgress(text, percent) {
    progress.hidden = false;
    if (Number.isFinite(percent)) progress.value = percent;
    else progress.removeAttribute("value");
    message.textContent = text;
  }

  function showEstimate(items, rejected, direct, excluded, folder) {
    approval = { items, rejected, direct, excluded, folder };
    renderEstimateSummary();
  }

  function renderEstimateSummary() {
    const { items, excluded } = approval;
    const pending = items.some((item) => item.needsEstimate);
    confirm.textContent = items.length + "件の一括保存を開始";
    find("download-estimate-output").textContent = pending ? "再確認が必要です" : summarizeDownloadSize(items);
    const unknown = items.filter((item) => !item.needsEstimate && !Number.isFinite(selectedDownloadEstimate(item)?.savedBytes)).length;
    const notes = [];
    if (unknown) notes.push(unknown + "件の保存容量は変換後に確定します。");
    notes.push("必要に応じてタイトルやアーティスト名を編集してから保存してください。");
    if (excluded) notes.push("エラーの " + excluded + "件は今回の保存対象から外れます。");
    estimateNote.hidden = !notes.length;
    estimateNote.textContent = notes.join(" ");
  }

  function renderEstimateRow(item) {
    const { savedBytes } = selectedDownloadEstimate(item) ?? {};
    const saved = Number.isFinite(savedBytes) ? "約 " + displayDownloadSize(savedBytes) : "変換後に確定";
    setRowState(item.row, "", "保存容量 " + saved);
  }

  function readItemFormat(item) {
    item.format = rowFormat(item.row);
    item.quality = item.row.quality.value;
  }

  async function prepareItem(item, request, signal) {
    const { row } = item;
    if (!row.mediaKind && !item.sourceChecked) {
      const response = await request("/api/downloads/info", {
        method: "POST", body: { url: item.url }, expectedStatuses: [400, 404, 422, 429, 504],
      });
      if (response.ok) {
        const info = await response.json().catch(() => null);
        signal.throwIfAborted();
        applyDownloadInfo(row, info);
        updatePreview(row);
        persistRows();
      }
      item.sourceChecked = true;
    }
    readItemFormat(item);
  }

  async function estimateItem(item, request, signal) {
    try {
      item.estimate = await estimateDownload(item, request);
    } catch (error) {
      if (error.cause !== "audio_only" || item.format !== "mp4") throw error;
      setRowMediaKind(item.row, "audio");
      readItemFormat(item);
      persistRows();
      item.estimate = await estimateDownload(item, request);
    }
    signal.throwIfAborted();
    applyDownloadInfo(item.row, item.estimate);
    persistRows();
    showQualitySizes(item.row, item.estimate?.qualities);
    renderEstimateRow(item);
  }

  function changeRowFormat(row) {
    row.formatChosen = true;
    setRowState(row);
    showQualitySizes(row);
    persistRows();
    const review = approval;
    const rejected = review?.rejected.get(row);
    const item = review?.items.find((entry) => entry.row === row) ?? rejected;
    if (!item) {
      updateControls();
      return;
    }
    const { direct } = review;
    const starting = startPCHelper(direct);
    readItemFormat(item);
    item.estimate = null;
    item.needsEstimate = true;
    renderEstimateSummary();
    setRowState(row, "", "容量を再確認しています…", true);
    runTask(async (signal) => {
      try {
        const request = await requestFor(direct, signal, starting);
        await estimateItem(item, request, signal);
        item.needsEstimate = false;
        if (rejected && approval === review) {
          review.rejected.delete(row);
          review.excluded--;
          review.items.push(item);
          review.items.sort((first, second) => rows.indexOf(first.row) - rows.indexOf(second.row));
        }
        message.textContent = "";
      } catch (error) {
        setRowState(row, "error", signal.aborted ? "容量の再確認を中止しました。" : error.message);
        throw error;
      } finally {
        if (approval === review) renderEstimateSummary();
      }
    });
  }

  function rowBatch() {
    const items = [];
    let excluded = 0;
    for (const row of rows) {
      const value = row.input.value.trim();
      if (!value) continue;
      const url = downloadPageUrl(value);
      if (!url) {
        setRowState(row, "error", "動画のHTTPSリンクを入力してください。");
        excluded++;
        continue;
      }
      setRowState(row);
      showQualitySizes(row);
      items.push({ row, url: url.href, format: rowFormat(row), quality: row.quality.value, playlist: isYoutubePlaylist(url) });
    }
    return { items, excluded };
  }

  function startPCHelper(direct) {
    if (!direct || job || location.origin === pcDownloadOrigin) return false;
    if (Date.now() - pcConnectedAt < 60_000) return false;
    // Keep the external app launch in the button's click handler.
    location.href = pcDownloadLaunchUrl;
    return true;
  }

  async function connectToPC(signal, starting) {
    try {
      const connection = await readPCDownloadConnection(signal, starting);
      pcConnectedAt = Date.now();
      return connection;
    } catch (error) {
      pcConnectedAt = 0;
      throw error;
    }
  }

  async function requestFor(direct, signal, starting) {
    if (direct) {
      showProgress(starting
        ? "PCの取得機能を起動しています。「開く」が表示されたら押してください。"
        : "PCの取得機能に接続しています…");
    } else {
      showProgress("取得サーバーに接続しています…");
    }
    const connection = direct ? await connectToPC(signal, starting) : readDownloadConnection();
    const request = await createDownloadRequest(connection, signal, showProgress);
    const response = await request("/api/downloads/options", { expectedStatuses: [404] });
    if (!response.ok || (await response.json().catch(() => null))?.qualityVersion !== 1) {
      throw new DownloadConnectionError("取得機能が画質設定に対応していません。取得サーバーを更新してからお試しください。");
    }
    return request;
  }

  async function expandPlaylists(items, excluded, request, signal) {
    const expanded = [];
    for (const item of items) {
      signal.throwIfAborted();
      if (!item.playlist) {
        expanded.push(item);
        continue;
      }
      const { row, url, format, quality } = item;
      showProgress("プレイリストを読み込んでいます…");
      setRowState(row, "", "プレイリストを読み込んでいます…", true);
      try {
        const response = await request("/api/downloads/playlist", { method: "POST", body: { url }, expectedStatuses: [404] });
        if (response.status === 404) throw new Error("プレイリストの取り込みには取得サーバーの更新が必要です。");
        const { ids, items: details } = await response.json();
        if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((id) => typeof id !== "string" || !/^[\w-]{11}$/.test(id))) {
          throw new Error("プレイリストに読み込める曲がありませんでした。");
        }
        signal.throwIfAborted();
        const metadata = new Map(Array.isArray(details) ? details.map((item) => [item?.id, item]) : []);
        for (const id of new Set(ids)) {
          const entry = metadata.get(id);
          const videoId = typeof entry?.videoId === "string" && /^[\w-]{11}$/.test(entry.videoId) ? entry.videoId : null;
          const mediaKind = entry?.kind ?? (entry?.video === true ? "video" : undefined);
          const trackFormat = mediaKind === "audio" ? row.audioFormat.value
            : !row.formatChosen && mediaKind === "video" ? "mp4" : format;
          const url = youtubeWatchUrl(videoId ?? id);
          const trackRow = appendRow(url, trackFormat, quality, row, {
            formatChosen: row.formatChosen,
            audioFormat: row.audioFormat.value,
            mediaKind,
            info: { title: entry?.title },
          });
          playlistPreviewObserver?.observe(trackRow.element);
          expanded.push({ row: trackRow, url, format: trackFormat, quality });
        }
        removeRow(row);
        numberRows();
        persistRows();
        updateControls();
      } catch (error) {
        setRowState(row, "error", signal.aborted ? "読み込みを中止しました。" : error.message);
        if (signal.aborted || error instanceof DownloadConnectionError) throw error;
        excluded++;
      }
    }
    return { items: expanded, excluded };
  }

  async function checkBatch(items, direct, excluded, request, signal, folder) {
    const eligible = [];
    const rejected = new Map();
    for (const [index, item] of items.entries()) {
      signal.throwIfAborted();
      const { row } = item;
      showProgress((index + 1) + " / " + items.length + " 件を確認しています…", index / items.length * 100);
      setRowState(row, "", "曲情報と容量を確認中…", true);
      try {
        await prepareItem(item, request, signal);
        await estimateItem(item, request, signal);
        eligible.push(item);
      } catch (error) {
        setRowState(row, "error", signal.aborted ? "容量確認を中止しました。" : error.message);
        if (signal.aborted || error instanceof DownloadConnectionError) throw error;
        rejected.set(row, item);
        excluded++;
      }
    }
    if (!eligible.length) {
      message.textContent = "容量を確認できる項目がありません。各行の表示を確認してください。";
      return;
    }
    if (direct) pcConnectedAt = Date.now();
    message.textContent = "";
    showEstimate(eligible, rejected, direct, excluded, folder);
  }

  async function saveBatch(items, excluded, request, signal, folder) {
    let saved = 0;
    let failed = excluded;
    for (const [index, item] of items.entries()) {
      signal.throwIfAborted();
      const { row } = item;
      showProgress((index + 1) + " / " + items.length + " 件を処理しています…", index / items.length * 100);
      try {
        await prepareItem(item, request, signal);
        const { format } = item;
        updatePreview(row);
        const input = await downloadVideoPage(item, request, signal,
          (text, percent) => setRowState(row, "", text, true, percent));
        applyDownloadInfo(row, input.info);
        updatePreview(row);
        const cover = format === "mp4" ? await row.cover : await audioDownloadArtwork(item.url, row.cover, signal);
        signal.throwIfAborted();
        setRowState(row, "", folder ? "フォルダに保存しています…" : "ライブラリに保存しています…", true);
        cancel.disabled = close.disabled = true;
        const name = (input.name ?? "").replace(/\.[a-z0-9]{1,6}$/i, "")
          .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim();
        const edits = readMediaEdits(row.element);
        await saveMedia(input.blob, (name.slice(0, 180) || "ダウンロード") + "." + format, format, cover, edits, folder);
        saved++;
        removeRow(row);
        numberRows();
        persistRows();
      } catch (error) {
        setRowState(row, "error", signal.aborted ? "保存を中止しました。" : error.message);
        if (signal.aborted || error instanceof DownloadConnectionError) throw error;
        failed++;
      } finally {
        cancel.disabled = close.disabled = false;
      }
    }
    const place = folder ? "「" + folder.name + "」" : "端末";
    message.textContent = saved + "件を" + place + "に保存しました。" + (failed ? "未保存 " + failed + "件" : "");
  }

  async function runTask(operation) {
    if (job) return;
    const controller = new AbortController();
    job = controller;
    const { signal } = controller;
    updateControls();
    message.textContent = "";
    message.setAttribute("data-loading", "");
    setScreenActivity("download", true);
    try {
      if (!/^https?:$/.test(location.protocol)) {
        throw new Error("この機能はGitHub Pagesの公開ページか、Windowsのローカルサーバーで使えます。");
      }
      await operation(signal);
    } catch (error) {
      if (signal.aborted) {
        message.textContent = "処理を中止しました。保存済みの項目はライブラリに残ります。";
      } else {
        message.textContent = error.message;
        if (error instanceof DownloadConnectionError) pcConnectedAt = 0;
      }
    } finally {
      message.removeAttribute("data-loading");
      setScreenActivity("download", false);
      job = null;
      progress.hidden = true;
      updateControls();
      if (dialog.open && approval) confirm.focus();
    }
  }

  function openDownloads(folder = null) {
    if (dialog.open) return;
    find("add-dialog").close();
    destination = folder;
    destinationLabel.hidden = !folder;
    destinationLabel.textContent = folder ? "保存先 「" + folder.name + "」" : "";
    if (!job) {
      message.textContent = "";
      for (const row of rows) updatePreview(row);
    }
    updateControls();
    dialog.showModal();
  }
  find("download-open").addEventListener("click", () => openDownloads());
  close.addEventListener("click", () => {
    job?.abort();
    approval = null;
    showOptions(false);
    dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (close.disabled) event.preventDefault();
    else {
      job?.abort();
      approval = null;
      showOptions(false);
    }
  });
  cancel.addEventListener("click", () => job?.abort());
  more.addEventListener("click", () => showOptions(options.hidden));
  dialog.addEventListener("pointerdown", (event) => {
    if (!options.hidden && !startActions.contains(event.target)) showOptions(false);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || options.hidden) return;
    event.preventDefault();
    showOptions(false);
    more.focus();
  });
  csvButton.addEventListener("click", () => csvInput.click());
  csvInput.addEventListener("change", async () => {
    const file = csvInput.files[0];
    csvInput.value = "";
    if (!file || job || approval || importing) return;
    importing = true;
    updateControls();
    csvMessage.textContent = "CSVを読み込んでいます…";
    csvMessage.setAttribute("data-loading", "");
    try {
      const { items, skipped } = readDownloadCsv(await file.text());
      if (items.length) {
        const blank = rows.at(-1);
        if (blank && !blank.input.value.trim()) removeRow(blank);
        for (const { url, format } of items) {
          appendRow(url, format);
          if (dialog.open) updatePreview(rows.at(-1));
        }
        ensureBlankRow();
        persistRows();
      }
      csvMessage.textContent = items.length ? items.length + "件を追加しました。" : "取り込めるURLがありませんでした。";
      if (skipped) csvMessage.textContent += " URLまたは形式を確認できない " + skipped + "件はスキップしました。";
    } catch (error) {
      csvMessage.textContent = error.message || "CSVを読み込めませんでした。";
    } finally {
      csvMessage.removeAttribute("data-loading");
      importing = false;
      updateControls();
    }
  });
  find("download-estimate-back").addEventListener("click", () => {
    approval = null;
    updateControls();
    start.focus();
  });
  function startBatch(skipEstimate) {
    showOptions(false);
    const { items, excluded } = rowBatch();
    if (!items.length) {
      message.textContent = "保存する動画の共有リンクを確認してください。";
      return;
    }
    const direct = onWindows;
    const folder = destination;
    const starting = startPCHelper(direct);
    runTask(async (signal) => {
      const request = await requestFor(direct, signal, starting);
      const batch = await expandPlaylists(items, excluded, request, signal);
      if (!batch.items.length) {
        message.textContent = "読み込める項目がありません。各行の表示を確認してください。";
      } else if (skipEstimate) await saveBatch(batch.items, batch.excluded, request, signal, folder);
      else await checkBatch(batch.items, direct, batch.excluded, request, signal, folder);
    });
  }
  start.addEventListener("click", () => startBatch(false));
  skip.addEventListener("click", () => startBatch(true));
  confirm.addEventListener("click", () => {
    if (!approval || approval.items.some((item) => item.needsEstimate)) return;
    const { items, direct, excluded, folder } = approval;
    approval = null;
    const starting = startPCHelper(direct);
    runTask(async (signal) => {
      const request = await requestFor(direct, signal, starting);
      await saveBatch(items, excluded, request, signal, folder);
    });
  });

  restoreRows();
  ensureBlankRow();
  updateControls();
  return openDownloads;
}
