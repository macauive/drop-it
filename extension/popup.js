const $ = (id) => document.getElementById(id);
const keys = ["title", "url", "text", "summary", "category", "tags", "notes"];
const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("review", query.has("review"));
let draft,
  currentId = query.get("draft"),
  identity = { connected: false, state: "checking", account: null },
  busy = false,
  writing = Promise.resolve(),
  confirming = "",
  tags = [],
  initialized = false,
  syncing;
let sourceTabId =
  query.has("tab") && /^\d+$/.test(query.get("tab"))
    ? Number(query.get("tab"))
    : undefined;
let lastEdit = "",
  editError = false;
function notice(text = "") {
  $("message").textContent = text;
  $("message").hidden = !text;
}
function captureNotice(value) {
  if (value?.saved) return "";
  if (value?.manual)
    return "Page access is unavailable. Enter or review the source link, or use the page's right-click menu for automatic capture.";
  if (value?.resumed)
    return "Restored your draft. Review the source link before saving.";
  return "";
}
async function call(type, rest = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...rest });
  if (!response?.ok) {
    const error = new Error(
      response?.error ||
        "Drop It could not finish. Reopen the extension and retry.",
    );
    error.code = response?.code;
    error.items = response?.items;
    throw error;
  }
  return response.data;
}
function values() {
  return Object.fromEntries(keys.map((key) => [key, $(key).value]));
}
function clearSuggestions() {
  tags = [];
  $("pool-options").replaceChildren();
  $("tag-options").replaceChildren();
}
function clearDraft() {
  draft = undefined;
  lastEdit = "";
  editError = false;
  for (const key of keys) $(key).value = "";
  $("saved-title").textContent = "";
  $("duplicate-links").replaceChildren();
  $("duplicates").hidden = true;
  $("preview-title").textContent = "";
  $("preview-url").textContent = "";
  $("notes-details").open = false;
  confirming = "";
  $("discard-confirm").hidden = true;
  controls();
}
function controls() {
  for (const element of document.body.children)
    if (element.id !== "discard-confirm" && element.tagName !== "SCRIPT")
      element.inert = Boolean(confirming);
  const connected = identity.connected;
  $("connection").hidden = connected;
  $("disconnect").hidden = !connected;
  $("account-status").textContent = connected
    ? `Connected · ${identity.account.label}`
    : identity.state === "checking"
      ? "Checking connection…"
      : identity.state === "offline"
        ? "Connection unavailable"
        : identity.account
          ? `Reconnect · ${identity.account.label}`
          : "Connect to save your capture";
  $("connection-heading").textContent =
    identity.state === "offline"
      ? "Connection unavailable"
      : identity.account
        ? "Reconnect to Drop It"
        : "Connect to Drop It";
  $("connection-copy").textContent =
    identity.state === "offline"
      ? "Your draft is preserved. Try connecting again to continue."
      : identity.account
        ? `Reconnect ${identity.account.label} to continue your draft.`
        : "Keep pages, selected text, and links in your library.";
  $("retry-connection").hidden = identity.state !== "offline";
  $("retry-connection").disabled = busy;
  $("connect").textContent = busy
    ? "Connecting…"
    : identity.account
      ? "Reconnect Drop It"
      : "Connect Drop It";
  $("capture").hidden = !connected || !draft || Boolean(draft.saved);
  $("save-bar").hidden = !connected || !draft || Boolean(draft.saved);
  $("capture-heading").hidden = !connected || Boolean(draft?.saved);
  $("empty").hidden = !connected || Boolean(draft);
  $("preview").hidden = connected || !draft || Boolean(draft.saved);
  if (!draft) $("kind").textContent = "CAPTURE";
  $("success").hidden = !draft?.saved;
  $("save").disabled = !connected || busy || !draft || Boolean(confirming);
  $("save").textContent = busy
    ? "Working…"
    : draft?.attempt
      ? "Retry save"
      : "Save drop";
  for (const id of ["connect", "disconnect", "new-capture", "discard"])
    $(id).disabled = busy || Boolean(confirming);
  $("again").disabled = busy;
  $("discard").hidden = !draft || Boolean(draft.saved);
  for (const key of keys)
    $(key).disabled = busy || Boolean(draft?.attempt) || Boolean(confirming);
  $("allow-duplicate").disabled =
    busy || Boolean(draft?.attempt) || Boolean(confirming);
}
function showDraft(next) {
  draft = next;
  currentId = next.id;
  if (Number.isInteger(next.tabId)) sourceTabId = next.tabId;
  for (const key of keys) $(key).value = next[key] || "";
  lastEdit = JSON.stringify([next.id, values()]);
  editError = false;
  $("preview-title").textContent = next.title || "Untitled capture";
  try {
    $("preview-url").textContent = new URL(next.url).hostname;
  } catch {
    $("preview-url").textContent = "Your current capture";
  }
  $("notes-details").open = Boolean(next.notes);
  $("text-field").hidden = next.kind !== "selection";
  $("kind").textContent =
    { page: "PAGE", selection: "SELECTED TEXT", link: "LINK" }[next.kind] ||
    "CAPTURE";
  $("duplicates").hidden = true;
  $("allow-duplicate").checked = false;
  if (next.saved) $("saved-title").textContent = next.saved.title;
  if (next.attempt)
    notice(
      "The last save needs confirmation. Retry this capture to confirm it safely.",
    );
  else if (captureNotice(next)) notice(captureNotice(next));
  suggestTags();
  controls();
}
function options(id, entries) {
  $(id).replaceChildren(
    ...entries.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    }),
  );
}
function suggestTags() {
  const parts = $("tags").value.split(","),
    term = parts.pop().trim().toLowerCase();
  const used = new Set(parts.map((value) => value.trim().toLowerCase()));
  const prefix = parts.length
    ? `${parts
        .map((value) => value.trim())
        .filter(Boolean)
        .join(", ")}, `
    : "";
  options(
    "tag-options",
    tags
      .filter(
        (tag) =>
          !used.has(tag.toLowerCase()) && tag.toLowerCase().includes(term),
      )
      .slice(0, 20)
      .map((tag) => prefix + tag),
  );
}
async function loadSuggestions() {
  clearSuggestions();
  if (!identity.connected) return;
  const accountId = identity.account.id;
  try {
    const result = await call("suggestions");
    if (
      identity.account?.id !== accountId ||
      result.accountId !== accountId ||
      !identity.connected
    )
      return;
    options("pool-options", result.pools);
    tags = result.tags;
    suggestTags();
  } catch {
    /* Suggestions are optional; manual entry always remains available. */
  }
}
async function account() {
  const next = await call("status");
  if (draft?.accountId && next.account?.id !== draft.accountId) clearDraft();
  identity = next;
  if (!next.connected) clearSuggestions();
  controls();
  if (next.notice) notice(next.notice);
  return next;
}
async function restoreDraft() {
  if (!currentId) return;
  try {
    showDraft(await call("draft", { id: currentId }));
  } catch (error) {
    currentId = null;
    clearDraft();
    notice(error.message);
  }
}
async function synchronize() {
  if (syncing) return syncing;
  syncing = (async () => {
    // Clear source text and labels immediately in other open review windows.
    clearSuggestions();
    clearDraft();
    identity = { connected: false, state: "checking", account: null };
    controls();
    try {
      await account();
      await restoreDraft();
      await loadSuggestions();
    } catch (error) {
      notice(error.message);
    }
  })().finally(() => {
    syncing = undefined;
  });
  return syncing;
}
chrome.runtime.onMessage.addListener((message, sender) => {
  if (
    initialized &&
    sender.id === chrome.runtime.id &&
    message?.type === "connection-changed"
  )
    void synchronize();
});
$("library").addEventListener("click", () => {
  void call("library").catch((error) => notice(error.message));
});
$("open-drop").addEventListener("click", () => {
  if (draft?.saved)
    void call("library", { id: draft.saved.id }).catch((error) =>
      notice(error.message),
    );
});
$("connect").addEventListener("click", async () => {
  busy = true;
  controls();
  notice(
    "Complete sign-in in the Drop It window. Reopen this popup to continue your capture.",
  );
  try {
    await writing.catch(() => {});
    identity = await call("connect");
    await restoreDraft();
    await loadSuggestions();
    if (identity.notice) notice(identity.notice);
    else notice(captureNotice(draft));
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    controls();
  }
});
$("disconnect").addEventListener("click", async () => {
  busy = true;
  controls();
  try {
    await call("disconnect");
    notice("Disconnected. Local drafts were cleared.");
  } catch (error) {
    notice(error.message);
  } finally {
    currentId = null;
    clearDraft();
    clearSuggestions();
    identity = { connected: false, state: "disconnected", account: null };
    busy = false;
    controls();
  }
});
$("retry-connection").addEventListener("click", async () => {
  busy = true;
  controls();
  try {
    notice();
    await account();
    await restoreDraft();
    await loadSuggestions();
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    controls();
  }
});
async function replaceCapture() {
  const previous = currentId;
  const next = await call("capture", {
    fresh: true,
    ...(sourceTabId === undefined ? {} : { tabId: sourceTabId }),
  });
  if (previous) await call("discard", { id: previous }).catch(() => {});
  showDraft(next);
  notice(captureNotice(next) || "New capture ready. Review it before saving.");
}
function focusCapture() {
  $(draft && !draft.saved ? "title" : "new-capture").focus();
}
function askDiscard(action) {
  if (busy || confirming) return;
  confirming = action;
  $("discard-heading").textContent =
    action === "new" ? "Start a new capture?" : "Discard this draft?";
  $("confirm-discard").textContent =
    action === "new" ? "Start new capture" : "Discard draft";
  $("discard-copy").textContent = draft?.attempt
    ? "The last save may already be in your library. Check the library before discarding this local confirmation."
    : action === "new"
      ? "Replace this local draft with the current page or selection?"
      : "Remove this unsaved draft from this browser session?";
  $("discard-confirm").hidden = false;
  controls();
  $("keep-editing").focus();
}
function cancelDiscard() {
  const action = confirming;
  confirming = "";
  $("discard-confirm").hidden = true;
  controls();
  $(action === "new" ? "new-capture" : "discard").focus();
}
$("new-capture").addEventListener("click", async () => {
  if (busy || confirming) return;
  if (draft && !draft.saved) {
    askDiscard("new");
    return;
  }
  busy = true;
  controls();
  try {
    await replaceCapture();
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    controls();
    focusCapture();
  }
});
$("discard").addEventListener("click", () => askDiscard("discard"));
$("keep-editing").addEventListener("click", cancelDiscard);
document.addEventListener("keydown", (event) => {
  if (!confirming) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancelDiscard();
  } else if (event.key === "Tab") {
    const first = $("keep-editing"),
      last = $("confirm-discard");
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
$("confirm-discard").addEventListener("click", async () => {
  if (busy || !confirming) return;
  const action = confirming;
  confirming = "";
  $("discard-confirm").hidden = true;
  busy = true;
  controls();
  try {
    await writing.catch(() => {});
    if (action === "new") await replaceCapture();
    else {
      await call("discard", { id: currentId });
      currentId = null;
      clearDraft();
      notice(
        "Draft discarded. Choose New capture to capture the current page.",
      );
    }
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    controls();
    focusCapture();
  }
});
$("again").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  controls();
  try {
    await replaceCapture();
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    controls();
    focusCapture();
  }
});
function persistDraft() {
  if (!draft || draft.saved || draft.attempt || busy || confirming) return;
  const edited = values(),
    id = draft.id;
  const snapshot = JSON.stringify([id, edited]);
  if (snapshot === lastEdit) return;
  lastEdit = snapshot;
  // Dispatch immediately so closing the popup does not drop edits waiting in
  // a popup-local promise chain. The background controller orders mutations.
  const update = call("update", { id, values: edited }).then(
    (result) => {
      if (draft?.id === id && lastEdit === snapshot && editError) {
        editError = false;
        notice(captureNotice(draft));
      }
      return result;
    },
    (error) => {
      if (draft?.id === id && lastEdit === snapshot) {
        lastEdit = "";
        editError = true;
        notice(
          "Your last edit could not be kept. Keep this popup open and try editing again.",
        );
      }
      throw error;
    },
  );
  writing = Promise.all([writing.catch(() => {}), update]).then(() => {});
  void writing.catch(() => {});
  suggestTags();
}
for (const key of keys) {
  // Listen at the field itself: some hosts do not bubble textarea edits.
  for (const name of ["input", "change", "blur"])
    $(key).addEventListener(name, persistDraft);
}
window.addEventListener("blur", persistDraft);
window.addEventListener("pagehide", persistDraft);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistDraft();
});
$("capture").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!draft || busy || !identity.connected || confirming) return;
  const edited = values(),
    id = draft.id;
  busy = true;
  controls();
  notice();
  try {
    await writing.catch(() => {});
    const result = await call("save", {
      id,
      values: edited,
      allowDuplicate: $("allow-duplicate").checked,
    });
    if (draft?.id === id) {
      showDraft({ ...draft, saved: result.saved, attempt: undefined });
      $("open-drop").focus();
    }
  } catch (error) {
    notice(error.message);
    if (error.code === "DUPLICATE" && draft?.id === id) {
      $("duplicates").hidden = false;
      $("duplicate-links").replaceChildren();
      for (const item of error.items || []) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = item.title;
        button.addEventListener("click", () => {
          void call("library", { id: item.id }).catch((error) =>
            notice(error.message),
          );
        });
        $("duplicate-links").append(button);
      }
    }
    try {
      if (draft?.id === id) draft = await call("draft", { id });
    } catch {
      currentId = null;
      clearDraft();
    }
    try {
      await account();
    } catch {
      /* Preserve the original save error. */
    }
  } finally {
    busy = false;
    controls();
  }
});
async function init() {
  try {
    await account();
  } catch (error) {
    identity = { connected: false, state: "offline", account: null };
    notice(error.message);
    controls();
  }
  if (!query.has("notice")) {
    try {
      showDraft(
        currentId
          ? await call("draft", { id: currentId })
          : await call("capture"),
      );
    } catch (error) {
      currentId = null;
      clearDraft();
      notice(error.message);
    }
  }
  await loadSuggestions();
  try {
    const { shortcut } = await call("shortcut");
    $("shortcut-info").textContent = shortcut || "Set a keyboard shortcut";
    $("shortcut-info").title = shortcut
      ? "Capture shortcut"
      : "Assign a shortcut at chrome://extensions/shortcuts";
    $("shortcut-info").hidden = false;
  } catch {
    /* Capture also works from the toolbar. */
  }
  initialized = true;
}
controls();
void init();
