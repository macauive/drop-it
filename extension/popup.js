const $ = (id) => document.getElementById(id);
const keys = ["title", "url", "text", "summary", "category", "tags", "notes"];
const query = new URLSearchParams(location.search);
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
function notice(text = "") {
  $("message").textContent = text;
  $("message").hidden = !text;
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
  for (const key of keys) $(key).value = "";
  $("saved-title").textContent = "";
  $("duplicate-links").replaceChildren();
  $("duplicates").hidden = true;
  confirming = "";
  $("discard-confirm").hidden = true;
  controls();
}
function controls() {
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
        ? "Reconnect your library"
        : "Connect your library";
  $("connection-copy").textContent =
    identity.state === "offline"
      ? "Your draft is preserved. Check the connection again to continue saving."
      : identity.account
        ? `Reconnect ${identity.account.label} to continue your draft. Switching accounts clears previous account captures.`
        : "Sign in to the same Drop It account you use on the web or in ChatGPT.";
  $("retry-connection").hidden = identity.state !== "offline";
  $("retry-connection").disabled = busy;
  $("connect").textContent = identity.account
    ? "Reconnect Drop It"
    : "Connect Drop It";
  $("capture").hidden = !draft || Boolean(draft.saved);
  $("success").hidden = !draft?.saved;
  $("save").disabled = !connected || busy || !draft || Boolean(confirming);
  $("save").textContent = busy
    ? "Working…"
    : draft?.attempt
      ? "Retry save"
      : "Save drop";
  for (const id of ["connect", "disconnect", "new-capture", "discard"])
    $(id).disabled = busy || Boolean(confirming);
  $("connect").disabled ||= identity.state === "offline";
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
  $("text-field").hidden = next.kind !== "selection";
  $("kind").textContent =
    { page: "WEB PAGE", selection: "SELECTED TEXT", link: "LINK" }[next.kind] ||
    "BROWSER CAPTURE";
  $("duplicates").hidden = true;
  $("allow-duplicate").checked = false;
  if (next.saved) $("saved-title").textContent = next.saved.title;
  if (next.attempt)
    notice(
      "The last save needs confirmation. Retry this capture to confirm it safely.",
    );
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
    if (!identity.notice && draft) notice();
    else if (identity.notice) notice(identity.notice);
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
  notice();
}
function focusCapture() {
  $(draft && !draft.saved ? "title" : "new-capture").focus();
}
function askDiscard(action) {
  confirming = action;
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
  if (event.key === "Escape" && confirming) {
    event.preventDefault();
    cancelDiscard();
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
$("capture").addEventListener("input", () => {
  if (!draft || draft.attempt || busy) return;
  const edited = values(),
    id = draft.id;
  // Dispatch immediately so closing the popup does not drop edits waiting in
  // a popup-local promise chain. The background controller orders mutations.
  const update = call("update", { id, values: edited });
  writing = Promise.all([writing.catch(() => {}), update]).then(() => {});
  void writing.catch(() => {});
  suggestTags();
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
    $("shortcut-info").textContent = shortcut
      ? `Capture shortcut: ${shortcut}`
      : "Assign a capture shortcut at chrome://extensions/shortcuts.";
    $("shortcut-info").hidden = false;
  } catch {
    /* Capture also works from the toolbar. */
  }
  initialized = true;
}
void init();
