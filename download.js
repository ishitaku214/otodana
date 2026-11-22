"use strict";

const downloadLimit = 128_000_000;
const downloadConnectionKey = "otodana-download-connection";

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
    throw new Error("取得サーバーのURLを入力してください。");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"];
  const local = loopback.includes(server.hostname) && loopback.includes(location.hostname);
  if (server.username || server.password || server.pathname !== "/" || server.search || server.hash ||
      (server.protocol !== "https:" && !(local && server.protocol === "http:"))) {
    throw new Error("取得サーバーのHTTPSアドレスを入力してください。");
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
  const tooLarge = "128MBを超えています。「ファイルを追加」から保存済みファイルを取り込めます。";
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
    throw new Error("取得サーバーが約2分以内に応答しませんでした。設定したURLやRenderの稼働状況を確認してください。");
  } finally {
    clearTimeout(notice);
  }
}

async function createDownloadRequest(connection, signal, showProgress) {
  if (!connection.origin || !connection.token) throw new Error("「取得サーバーの設定」を開き、URLと接続キーを保存してください。");
  const origin = downloadServerOrigin(connection.origin);
  if (new URL(origin).hostname.endsWith(".onrender.com")) await waitForRenderServer(origin, signal, showProgress);
  return async (path, { method = "GET", body, requestSignal = signal } = {}) => {
    let response;
    try {
      response = await fetch(origin + path, {
        method, body: body ? JSON.stringify(body) : undefined, signal: requestSignal,
        headers: { Authorization: "Bearer " + connection.token, ...(body && { "Content-Type": "application/json" }) },
        credentials: "omit", cache: "no-store", redirect: "error",
      });
    } catch (error) {
      if (requestSignal.aborted) throw error;
      throw new Error("取得サーバーに接続できません。設定したURLやサーバーの動作をご確認ください。");
    }
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(typeof details.message === "string" ? details.message : "取得サーバーでエラーが発生しました。");
    }
    return response;
  };
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

async function downloadMediaKind(blob) {
  const read = async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  const begins = (bytes, start, text) => Array.from(text).every((letter, index) => bytes[start + index] === letter.charCodeAt(0));
  const mp3Frame = (bytes) => bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 0xe6) === 0xe2 &&
    (bytes[1] & 0x18) !== 8 && (bytes[2] >> 4) !== 15 && (bytes[2] & 12) !== 12;
  const bytes = await read(0, 16);
  if (mp3Frame(bytes)) return "mp3";
  if (begins(bytes, 0, "ID3") && bytes.length >= 10 && bytes.slice(6, 10).every((value) => value < 128)) {
    const tagSize = bytes.slice(6, 10).reduce((size, value) => size * 128 + value, 0);
    const footerSize = bytes[3] === 4 && (bytes[5] & 16) ? 10 : 0;
    const start = 10 + tagSize + footerSize;
    if (mp3Frame(await read(start, start + 4))) return "mp3";
  }
  if (["ftyp", "moov", "mdat", "wide"].some((type) => begins(bytes, 4, type)) ||
      begins(bytes, 0, "OggS") || begins(bytes, 0, "fLaC") ||
      (begins(bytes, 0, "RIFF") && begins(bytes, 8, "WAVE")) ||
      (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) return "convertible";
  throw new Error("このリンクやファイルに対応する動画・音声が見つかりませんでした。");
}

function convertedMedia(blob, format, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const worker = new Worker("download-worker.js?v=16");
    const finish = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.phase) {
        onProgress(data);
        return;
      }
      finish();
      if (data.error) reject(new Error(data.error));
      else resolve(data.blob);
    };
    worker.onerror = () => {
      finish();
      reject(new Error("変換機能を実行できませんでした。音棚を開き直してお試しください。"));
    };
    worker.postMessage({ blob, format });
  });
}

function setupMediaDownloads(saveMedia) {
  const find = (id) => document.getElementById(id);
  const dialog = find("download-dialog");
  const urlField = find("download-url");
  const fileField = find("download-file");
  const fileName = find("download-file-name");
  const config = find("download-config");
  const serverField = find("download-server");
  const tokenField = find("download-token");
  const saveConfig = find("download-config-save");
  const menu = find("download-options");
  const showOptions = find("download-formats");
  const progress = find("download-progress");
  const estimatePanel = find("download-estimate");
  const confirm = find("download-confirm");
  const message = find("download-message");
  const cancel = find("download-cancel");
  const close = find("download-close");
  const formats = Array.from(menu.querySelectorAll("button"));
  let connection = readDownloadConnection();
  let job;
  let checkedDownload;
  serverField.value = connection.origin || "";
  tokenField.value = connection.token || "";

  function showProgress(text, percent) {
    progress.hidden = false;
    if (Number.isFinite(percent)) progress.value = percent;
    else progress.removeAttribute("value");
    message.textContent = text;
  }

  function clearFeedback() {
    progress.hidden = true;
    estimatePanel.hidden = true;
    checkedDownload = null;
    message.textContent = "";
  }

  function showEstimate(estimate, input) {
    const max = Number.isFinite(estimate.maxSavedBytes) ? estimate.maxSavedBytes : downloadLimit;
    find("download-estimate-title").textContent = estimate.title;
    find("download-estimate-source").textContent = Number.isFinite(estimate.sourceBytes)
      ? (estimate.approximate ? "約 " : "") + displayDownloadSize(estimate.sourceBytes)
      : "確認できません";
    find("download-estimate-output").textContent = Number.isFinite(estimate.savedBytes)
      ? "約 " + displayDownloadSize(estimate.savedBytes) + "（上限 " + displayDownloadSize(max) + "）"
      : "変換後に確定（上限 " + displayDownloadSize(max) + "）";
    confirm.textContent = input.format.toUpperCase() + "で保存を開始";
    clearFeedback();
    checkedDownload = input;
    menu.hidden = true;
    showOptions.setAttribute("aria-expanded", "false");
    estimatePanel.hidden = false;
    confirm.focus();
  }

  function toggleRunning(running) {
    for (const element of [urlField, fileField, showOptions, serverField, tokenField, saveConfig, ...formats]) element.disabled = running;
    cancel.hidden = !running;
    cancel.disabled = close.disabled = false;
  }

  find("download-open").addEventListener("click", () => {
    if (dialog.open) return;
    dialog.showModal();
  });
  close.addEventListener("click", () => {
    if (job) job.abort();
    dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (close.disabled) event.preventDefault();
    else job?.abort();
  });
  cancel.addEventListener("click", () => job?.abort());
  saveConfig.addEventListener("click", () => {
    try {
      const origin = downloadServerOrigin(serverField.value);
      const token = tokenField.value.trim();
      if (token.length < 24) throw new Error("取得サーバーの接続キーを入力してください。");
      const settings = { origin, token };
      localStorage.setItem(downloadConnectionKey, JSON.stringify(settings));
      connection = settings;
      config.open = false;
      clearFeedback();
      message.textContent = "取得サーバーの設定を保存しました。";
    } catch (error) {
      message.textContent = error.message;
    }
  });
  urlField.addEventListener("input", () => {
    fileField.value = "";
    fileName.textContent = "";
    clearFeedback();
  });
  fileField.addEventListener("change", () => {
    const file = fileField.files[0];
    if (file) urlField.value = "";
    fileName.textContent = file?.name ?? "";
    clearFeedback();
  });
  showOptions.addEventListener("click", () => {
    if (checkedDownload) clearFeedback();
    menu.hidden = !menu.hidden;
    showOptions.setAttribute("aria-expanded", String(!menu.hidden));
  });
  find("download-estimate-back").addEventListener("click", () => {
    clearFeedback();
    menu.hidden = false;
    showOptions.setAttribute("aria-expanded", "true");
    formats[0].focus();
  });
  confirm.addEventListener("click", () => {
    if (checkedDownload) run(checkedDownload.format, checkedDownload.url);
  });

  async function run(format, approvedUrl) {
    if (job) return;
    clearFeedback();
    const controller = new AbortController();
    job = controller;
    const { signal } = controller;
    toggleRunning(true);
    try {
      if (!/^https?:$/.test(location.protocol)) {
        throw new Error("この機能はGitHub Pagesの公開ページか、Windowsのローカルサーバーで使えます。");
      }
      const file = fileField.files[0];
      let input;
      let output;
      if (file) {
        if (!file.size || file.size > downloadLimit) throw new Error("変換するファイルは128MB以下のものを選んでください。");
        input = { blob: file, name: file.name };
        const kind = await downloadMediaKind(input.blob);
        output = kind === "mp3" && format === "mp3"
          ? input.blob.slice(0, input.blob.size, "audio/mpeg")
          : await convertedMedia(input.blob, format, signal, ({ phase, percent }) => {
            if (phase === "engine") showProgress("変換機能を読み込んでいます…");
            else showProgress("端末内で" + format.toUpperCase() + "に変換中…" +
              (percent === undefined ? "" : " " + percent + "%"), percent);
          });
      } else {
        const url = approvedUrl ?? urlField.value.trim();
        if (!url) throw new Error("YouTubeまたはニコニコ動画の共有リンクを入力してください。");
        if (!connection.origin || !connection.token) config.open = true;
        const request = await createDownloadRequest(connection, signal, showProgress);
        if (!approvedUrl) {
          showProgress("動画の容量を確認しています…");
          const response = await request("/api/downloads/estimate", { method: "POST", body: { url, format } });
          const estimate = await response.json();
          signal.throwIfAborted();
          showEstimate(estimate, { url, format });
          return;
        }
        input = await downloadVideoPage(url, format, request, signal, showProgress);
        output = input.blob;
      }
      if (signal.aborted) throw signal.reason;
      cancel.disabled = close.disabled = true;
      showProgress("ライブラリに保存しています…");
      const name = (input.name ?? "").replace(/\.[a-z0-9]{1,6}$/i, "").replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim();
      await saveMedia(output, (name.slice(0, 180) || "ダウンロード") + "." + format, format);
      urlField.value = fileField.value = "";
      fileName.textContent = "";
      clearFeedback();
      dialog.close();
    } catch (error) {
      progress.hidden = true;
      message.textContent = signal.aborted ? "中止しました。" : error.message;
    } finally {
      job = null;
      toggleRunning(false);
    }
  }

  for (const format of formats) format.addEventListener("click", () => run(format.value));
}
