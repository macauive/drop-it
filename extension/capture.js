export function webUrl(value) {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Use a web address of 2,048 characters or fewer.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Use a valid web address.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Drop It captures HTTP and HTTPS pages without credentials in the address.",
    );
  return url.href;
}

export function makeCapture(info, tab, id = crypto.randomUUID()) {
  const kind =
    info.menuItemId === "drop-link"
      ? "link"
      : info.selectionText
        ? "selection"
        : "page";
  const url = webUrl(
    kind === "link" ? info.linkUrl : info.frameUrl || info.pageUrl || tab?.url,
  );
  const text = kind === "selection" ? info.selectionText : "";
  if (typeof text !== "string" || text.length > 50000)
    throw new Error("Select up to 50,000 characters, then try again.");
  const title =
    kind === "link"
      ? new URL(url).hostname
      : kind === "selection"
        ? text.trim().slice(0, 100)
        : tab?.title;
  return {
    id,
    kind,
    tabId: tab?.id,
    pageUrl: tab?.url,
    createdAt: Date.now(),
    title: (title || new URL(url).hostname).slice(0, 200),
    url,
    text,
    summary: "",
    category: "Uncategorized",
    tags: "",
    notes: "",
  };
}

export function readValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Review the capture before saving.");
  const lengths = {
    title: 200,
    url: 2048,
    text: 50000,
    summary: 4000,
    category: 120,
    tags: 500,
    notes: 8000,
  };
  if (Object.keys(values).some((key) => !Object.hasOwn(lengths, key)))
    throw new Error("Unexpected capture field.");
  for (const [key, limit] of Object.entries(lengths)) {
    if (typeof values[key] !== "string" || values[key].length > limit)
      throw new Error(`Check the ${key} length.`);
  }
  return Object.fromEntries(
    Object.keys(lengths).map((key) => [key, values[key]]),
  );
}

export function savePayload(draft, input, allowDuplicate = false) {
  const values = readValues(input);
  if (!values.title.trim()) throw new Error("Add a title before saving.");
  const tags = [
    ...new Set(
      values.tags
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (tags.length > 12 || tags.some((tag) => tag.length > 40))
    throw new Error("Use up to 12 tags, each 40 characters or fewer.");
  const category =
    values.category.normalize("NFKC").trim().replace(/ +/g, " ") ||
    "Uncategorized";
  if (
    category.length > 60 ||
    !/^[\p{L}\p{M}\p{N} &+/'().,-]+$/u.test(category) ||
    !/[\p{L}\p{N}]/u.test(category)
  )
    throw new Error(
      "Use a pool name of up to 60 characters without special control characters.",
    );
  return {
    requestId: draft.id,
    title: values.title.trim(),
    summary: values.summary.trim(),
    category,
    tags,
    notes: values.notes.trim(),
    source: { originalText: values.text, url: webUrl(values.url.trim()) },
    allowDuplicate,
  };
}

export class CaptureError extends Error {
  constructor(message, status = 0, code = "", items = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.items = items;
  }
}

export async function jsonRequest(origin, path, init = {}, transport = fetch) {
  // All network destinations are fixed paths on the build's one service origin.
  let response;
  try {
    response = await transport(`${origin}${path}`, {
      ...init,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new CaptureError(
      "Could not reach Drop It. Check your connection and retry.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new CaptureError(
      "Drop It returned an unreadable response. Retry the request.",
    );
  }
  if (!response.ok) {
    // Only known capture errors may supply text. OAuth/provider errors never
    // echo request bodies, tokens, internal details, or arbitrary server text.
    const messages = {
      DUPLICATE: "This source is already in your library.",
      VALIDATION: "Check the capture fields and their lengths.",
      REQUEST_REUSED:
        "This capture was already saved with different details. Check your library.",
      ORIGIN: "This extension is not enabled on this Drop It server yet.",
      SCOPE: "Reconnect Drop It to allow saving captures.",
      ACCOUNT_CHANGED:
        "This capture belongs to another Drop It account. Start a new capture.",
    };
    const message =
      response.status === 401
        ? "Reconnect your Drop It account."
        : (Object.hasOwn(messages, data?.code) ? messages[data.code] : "") ||
          (path === "/register"
            ? "The server has not enabled this extension’s sign-in callback. See extension setup."
            : response.status === 429
              ? "Too many requests. Wait a minute and retry."
              : "Drop It could not complete the request. Please retry.");
    const items =
      data?.code === "DUPLICATE" && Array.isArray(data.items)
        ? data.items
            .slice(0, 5)
            .filter(
              (item) =>
                typeof item?.id === "string" &&
                /^[a-f0-9-]{36}$/.test(item.id) &&
                typeof item.title === "string" &&
                item.title.length <= 200,
            )
        : [];
    throw new CaptureError(
      message,
      response.status,
      typeof data?.code === "string" ? data.code : "",
      items,
    );
  }
  return data;
}
