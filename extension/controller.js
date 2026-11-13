import {
  CaptureError,
  jsonRequest,
  makeCapture,
  makeManualCapture,
  readValues,
  savePayload,
  applyDraftSuggestions,
} from "./capture.js";
import { createOAuth } from "./oauth.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function openReview(api, path) {
  const url = api.runtime.getURL(path);
  // A regular extension tab also works in hosts that cannot create windows.
  await api.tabs.create({ url, active: true });
}
export function createController(api, origin, transport = fetch) {
  const oauth = createOAuth(api, origin, transport);
  let queue = Promise.resolve();
  const serial = (task) => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };
  async function initialize() {
    const { captureStateVersion } = await api.storage.session.get(
      "captureStateVersion",
    );
    if (captureStateVersion !== 2) {
      // Legacy drafts have no provable owner. Do not adopt or replay them.
      await api.storage.session.set({
        captureStateVersion: 2,
        captures: {},
        activeAccount: null,
        suggestions: null,
      });
    }
  }
  async function announce() {
    // Wake other open review windows so stale account data leaves their UI.
    try {
      await api.runtime.sendMessage?.({ type: "connection-changed" });
    } catch {
      /* No popup is open. */
    }
  }
  async function drafts() {
    const { captures = {} } = await api.storage.session.get("captures");
    return Object.fromEntries(
      Object.entries(captures)
        .filter(([, draft]) => Date.now() - draft.createdAt < 3600000)
        .sort((a, b) => a[1].createdAt - b[1].createdAt)
        .slice(-12),
    );
  }
  async function put(draft) {
    const captures = await drafts();
    captures[draft.id] = draft;
    await api.storage.session.set({
      captures: Object.fromEntries(Object.entries(captures).slice(-12)),
    });
    return draft;
  }
  async function get(id) {
    if (typeof id !== "string" || !uuid.test(id))
      throw new CaptureError(
        "This capture is unavailable. Start a new capture.",
        409,
        "CAPTURE_UNAVAILABLE",
      );
    const draft = (await drafts())[id];
    const { activeAccount } = await api.storage.session.get("activeAccount");
    if (!draft || (draft.accountId && draft.accountId !== activeAccount?.id))
      throw new CaptureError(
        "This capture expired or belongs to a previous account. Start a new capture.",
        409,
        "CAPTURE_UNAVAILABLE",
      );
    return draft;
  }
  async function authenticated(path, init = {}) {
    const access = await oauth.access();
    try {
      return await jsonRequest(
        origin,
        path,
        {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${access}` },
        },
        transport,
      );
    } catch (error) {
      if (error.status === 401) await api.storage.session.remove("connection");
      throw error;
    }
  }
  async function verifyConnection() {
    const result = await authenticated("/extension/v1/connection");
    const account = result?.account;
    if (
      result?.connected !== true ||
      !uuid.test(account?.id) ||
      typeof account.label !== "string" ||
      !/^[^\p{C}]{1,80}$/u.test(account.label)
    )
      throw new CaptureError(
        "The Drop It server needs the latest extension update before you can connect.",
      );
    const { activeAccount } = await api.storage.session.get("activeAccount");
    const switched = Boolean(activeAccount && activeAccount.id !== account.id);
    const captures = await drafts();
    // Keep same-account drafts through token expiry/reconnection, but never
    // transfer bound captures, saved confirmations, or frozen retries to B.
    const owned = Object.fromEntries(
      Object.entries(captures)
        .filter(
          ([, draft]) => !draft.accountId || draft.accountId === account.id,
        )
        .map(([id, draft]) => [id, { ...draft, accountId: account.id }]),
    );
    await api.storage.session.set({
      activeAccount: account,
      captures: owned,
      ...(activeAccount?.id !== account.id ? { suggestions: null } : {}),
    });
    if (activeAccount?.id !== account.id) void announce();
    return {
      connected: true,
      state: "connected",
      account,
      notice: switched
        ? "Account changed. Previous account captures were cleared. Start a new capture."
        : "",
    };
  }
  async function status() {
    const { connection, activeAccount, connectionNotice } =
      await api.storage.session.get([
        "connection",
        "activeAccount",
        "connectionNotice",
      ]);
    if (!connection)
      return {
        connected: false,
        state: activeAccount ? "expired" : "disconnected",
        account: activeAccount,
        notice:
          connectionNotice ||
          (activeAccount
            ? `Reconnect ${activeAccount.label} to continue. Your draft is preserved.`
            : ""),
      };
    try {
      const result = await verifyConnection();
      if (connectionNotice) {
        await api.storage.session.remove("connectionNotice");
        if (!result.notice) result.notice = connectionNotice;
      }
      return result;
    } catch (error) {
      return {
        connected: false,
        state: error.status === 401 ? "expired" : "offline",
        account: activeAccount,
        notice:
          error.status === 401
            ? "Your connection expired. Reconnect the same account to continue your draft."
            : error.message,
      };
    }
  }
  async function currentCapture(fresh, tabId) {
    let tab;
    if (tabId !== undefined) {
      if (!Number.isInteger(tabId) || tabId < 0)
        throw new CaptureError("Open the source page to capture it again.");
      try {
        tab = await api.tabs.get(tabId);
      } catch {
        throw new CaptureError(
          "The source tab closed. Open a web page to capture it.",
        );
      }
    } else
      [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new CaptureError("Open a web page to capture it.");
    const { activeAccount } = await api.storage.session.get("activeAccount");
    const pending = Object.values(await drafts()).findLast(
      (draft) =>
        draft.toolbar &&
        draft.tabId === tab.id &&
        (!draft.accountId || draft.accountId === activeAccount?.id) &&
        !draft.saved,
    );
    // Resuming user edits must not depend on a renewed activeTab grant. Keep
    // the preserved source explicit rather than pretending it is today's page.
    if (!fresh && pending && (pending.manual || !tab.url))
      return { ...pending, resumed: true };
    let selectionText = "";
    try {
      const [injection] = await api.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          url: window.location.href,
          title: document.title.slice(0, 200),
          selectionText: (window.getSelection()?.toString() || "").slice(
            0,
            50001,
          ),
        }),
      });
      const page = injection?.result;
      // activeTab can permit injection while a browser host omits Tab.url.
      // Read metadata only from this user-invoked tab, never another open tab.
      if (typeof page?.url === "string") tab = { ...tab, url: page.url };
      if (typeof page?.title === "string")
        tab = { ...tab, title: page.title.slice(0, 200) };
      if (typeof page?.selectionText === "string")
        selectionText = page.selectionText;
    } catch {
      /* A known page URL still permits URL-only capture if injection is denied. */
    }
    if (!fresh && pending && pending.pageUrl === tab.url)
      return { ...pending, resumed: true };
    return put({
      ...(tab.url
        ? makeCapture({ selectionText }, tab)
        : makeManualCapture(tab)),
      toolbar: true,
      accountId: activeAccount?.id ?? null,
    });
  }
  async function suggestions() {
    const identity = await verifyConnection();
    const { suggestions: cached } =
      await api.storage.session.get("suggestions");
    if (
      cached?.accountId === identity.account.id &&
      Date.now() - cached.at < 60000
    )
      return cached;
    const data = await authenticated("/extension/v1/suggestions");
    if (
      data?.accountId !== identity.account.id ||
      !Array.isArray(data.pools) ||
      data.pools.length > 100 ||
      !Array.isArray(data.tags) ||
      data.tags.length > 200 ||
      data.pools.some(
        (value) =>
          typeof value !== "string" || value.length < 1 || value.length > 60,
      ) ||
      data.tags.some(
        (value) =>
          typeof value !== "string" || value.length < 1 || value.length > 40,
      )
    )
      throw new CaptureError(
        "Suggestions are unavailable. You can still enter a pool and tags.",
      );
    const value = { ...data, at: Date.now() };
    await api.storage.session.set({ suggestions: value });
    return value;
  }
  async function dispatch(message) {
    if (!message || typeof message !== "object" || Array.isArray(message))
      throw new CaptureError("Unknown extension request.");
    switch (message.type) {
      case "status":
        return status();
      case "connect":
        try {
          await oauth.connect();
          const identity = await verifyConnection();
          await api.storage.session.remove("connectionNotice");
          return identity;
        } catch (error) {
          await api.storage.session.set({ connectionNotice: error.message });
          throw error;
        }
      case "disconnect": {
        let failed = false;
        try {
          await oauth.disconnect();
        } catch {
          failed = true;
        }
        // Explicit disconnect clears local captures, including stale review
        // windows. An expired token follows a different, draft-preserving path.
        await api.storage.session.set({
          captures: {},
          activeAccount: null,
          suggestions: null,
          connectionNotice: "",
        });
        void announce();
        if (failed)
          throw new CaptureError(
            "Disconnected on this browser. To confirm server revocation, use Settings in Drop It.",
          );
        return { connected: false, state: "disconnected", account: null };
      }
      case "suggestions":
        return suggestions();
      case "capture":
        return currentCapture(message.fresh === true, message.tabId);
      case "draft":
        return get(message.id);
      case "discard": {
        await get(message.id);
        const captures = await drafts();
        delete captures[message.id];
        await api.storage.session.set({ captures });
        return {};
      }
      case "update": {
        const draft = await get(message.id);
        if (draft.saved || draft.attempt) return draft;
        const values = readValues(message.values);
        return put({
          ...draft,
          ...values,
          editedFields: [
            ...new Set([
              ...(draft.editedFields || []),
              ...["title", "summary", "category", "tags"].filter(
                (key) => values[key] !== draft[key],
              ),
            ]),
          ],
          ...(values.url !== draft.url
            ? { retrieval: undefined, retrievalToken: undefined }
            : {}),
        });
      }
      case "cancel-retrieval": {
        const draft = await get(message.id);
        return put({
          ...draft,
          retrievalToken: undefined,
          ...(message.remove ? { retrieval: undefined } : {}),
        });
      }
      case "save": {
        const identity = await verifyConnection();
        const draft = await get(message.id);
        if (draft.accountId !== identity.account.id)
          throw new CaptureError(
            "Account changed. Start a new capture.",
            409,
            "ACCOUNT_CHANGED",
          );
        if (draft.saved) return { saved: draft.saved };
        const payload = draft.attempt || {
          ...savePayload(
            draft,
            message.values,
            message.allowDuplicate === true,
          ),
          accountId: draft.accountId,
        };
        if (payload.accountId !== identity.account.id)
          throw new CaptureError(
            "Account changed. Start a new capture.",
            409,
            "ACCOUNT_CHANGED",
          );
        const pending = {
          ...draft,
          ...(draft.attempt ? {} : readValues(message.values)),
          attempt: payload,
        };
        await put(pending);
        try {
          const result = await authenticated("/extension/v1/capture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (
            !uuid.test(result?.id) ||
            typeof result.title !== "string" ||
            result.title.length > 200
          )
            throw new CaptureError(
              "Save confirmation was unreadable. Retry to confirm the save.",
            );
          const saved = { id: result.id, title: result.title };
          await put({ ...pending, saved, attempt: undefined });
          await api.storage.session.remove("suggestions");
          return { saved };
        } catch (error) {
          if (
            error.status >= 400 &&
            error.status < 500 &&
            error.code !== "REQUEST_REUSED"
          )
            await put({ ...pending, attempt: undefined });
          throw error;
        }
      }
      case "library": {
        const id = message.id;
        if (id !== undefined && (typeof id !== "string" || !uuid.test(id)))
          throw new CaptureError("Invalid drop link.");
        await api.tabs.create({
          url: id ? `${origin}/?drop=${id}` : `${origin}/`,
        });
        return {};
      }
      case "shortcut": {
        const commands = await api.commands.getAll();
        return {
          shortcut:
            commands.find((command) => command.name === "_execute_action")
              ?.shortcut || "",
        };
      }
      default:
        throw new CaptureError("Unknown extension request.");
    }
  }
  return {
    handle(message) {
      if (message?.type === "retrieve") return retrieve(message);
      return serial(async () => {
        await initialize();
        return dispatch(message);
      });
    },
    context(info, tab) {
      return serial(async () => {
        await initialize();
        const { activeAccount } =
          await api.storage.session.get("activeAccount");
        const draft = await put({
          ...makeCapture(info, tab),
          accountId: activeAccount?.id ?? null,
        });
        await openReview(
          api,
          `popup.html?draft=${draft.id}&review=1${Number.isInteger(tab?.id) ? `&tab=${tab.id}` : ""}`,
        );
      });
    },
  };

  async function retrieve(message) {
    // Do not block edit/discard/disconnect mutations behind provider latency.
    const before = await serial(async () => {
      await initialize();
      const identity = await verifyConnection();
      const draft = await get(message.id);
      if (
        draft.accountId !== identity.account.id ||
        draft.saved ||
        draft.attempt ||
        draft.retrievalToken
      )
        throw new CaptureError(
          "This capture cannot retrieve a page right now.",
        );
      const next = { ...draft, retrievalToken: crypto.randomUUID() };
      await put(next);
      return next;
    });
    try {
      const result = await authenticated("/extension/v1/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: before.accountId,
          source: { url: before.url, originalText: before.text },
        }),
      });
      if (
        result.accountId !== before.accountId ||
        !result.draft ||
        typeof result.draft.title !== "string" ||
        typeof result.draft.summary !== "string" ||
        typeof result.draft.category !== "string" ||
        !Array.isArray(result.draft.tags) ||
        result.draft.tags.some(
          (tag) => typeof tag !== "string" || tag.length > 40,
        ) ||
        (result.retrieval &&
          (!uuid.test(result.retrieval.id) ||
            result.retrieval.snapshot?.requestedUrl !== before.url ||
            typeof result.retrieval.snapshot.text !== "string" ||
            result.retrieval.snapshot.text.length > 30000))
      )
        throw new CaptureError(
          "Page suggestions were unreadable. Save manually or retry.",
        );
      return await serial(async () => {
        const current = await get(before.id);
        if (
          current.retrievalToken !== before.retrievalToken ||
          current.saved ||
          current.attempt
        )
          return current;
        return put({
          ...applyDraftSuggestions(current, before, result),
          retrievalToken: undefined,
        });
      });
    } catch (error) {
      await serial(async () => {
        const current = await get(before.id).catch(() => undefined);
        if (current?.retrievalToken === before.retrievalToken)
          await put({ ...current, retrievalToken: undefined });
      });
      throw error;
    }
  }
}
