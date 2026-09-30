import React, { useState, useEffect, useCallback, useRef, useId } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownToLine,
  Droplet,
  Sparkles,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  FileText,
  Image as ImageIcon,
  Inbox,
  Link as LinkIcon,
  LoaderCircle,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
  FolderOpen,
  Pencil,
  PlugZap,
} from "lucide-react";
import {
  statuses,
  type Item,
  type Source,
  type SaveInput,
  type SearchResult,
} from "../shared/schema.js";
import { api, client, ClientError, embedded } from "./client.js";
import {
  fileAccept,
  fileMime,
  isImageMime,
  maxFileBytes,
} from "../shared/files.js";
import "./style.css";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
const categoryTone = (category: string) => {
  let hash = 0;
  for (const letter of category.toLowerCase())
    hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  return `category-tone-${hash % 6}`;
};
function CategoryField({
  value,
  onChange,
  categories,
}: {
  value: string;
  onChange: (value: string) => void;
  categories: string[];
}) {
  const id = useId();
  return (
    <label>
      Category
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        list={id}
        maxLength={60}
        placeholder="Uncategorized"
      />
      <datalist id={id}>
        {categories.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </label>
  );
}
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
const icons = {
  Saved: Bookmark,
  "In progress": Clock3,
  Done: Check,
  Dismissed: X,
};
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon" aria-hidden="true">
        <Droplet size={19} strokeWidth={1.8} />
        <span className="brand-tray" />
      </span>
      <span>
        drop it<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
function Busy() {
  return <LoaderCircle className="spin" size={18} aria-label="Loading" />;
}
function Alert({ text }: { text: string }) {
  return text ? (
    <div className="error" role="alert">
      {text}
    </div>
  ) : null;
}

function App() {
  const [session, setSession] = useState<{
    authenticated: boolean;
    needsSetup: boolean;
    localSetup: boolean;
  } | null>(
    embedded
      ? { authenticated: true, needsSetup: false, localSetup: false }
      : null,
  );
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    api<typeof session>("/api/session")
      .then(setSession)
      .catch((e) => setError(message(e)));
  }, []);
  useEffect(() => {
    if (!embedded) refresh();
  }, [refresh]);
  if (error)
    return (
      <main className="auth-shell">
        <Brand />
        <Alert text={error} />
        <button
          onClick={() => {
            setError("");
            refresh();
          }}
        >
          Retry
        </button>
      </main>
    );
  if (!session)
    return (
      <main className="loading">
        <Busy />
      </main>
    );
  if (!session.authenticated)
    return (
      <Login
        setup={session.needsSetup}
        local={session.localSetup}
        onSuccess={refresh}
      />
    );
  const authorization = new URLSearchParams(location.search).get("authorize");
  if (authorization && !embedded) return <Consent id={authorization} />;
  return <Library onLogout={refresh} />;
}
function Login({
  setup,
  local,
  onSuccess,
}: {
  setup: boolean;
  local: boolean;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="auth-shell">
      <Brand />
      <div className="auth-form">
        <span className="eyebrow">YOUR PRIVATE LIBRARY</span>
        <h1>{setup ? "Make a little room." : "Welcome back."}</h1>
        <p className="muted">
          {setup
            ? "A place for the things worth keeping."
            : "Your saved ideas are right where you left them."}
        </p>
        {setup && !local ? (
          <Alert text="Open Drop It locally to create the owner account." />
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api(setup ? "/api/setup" : "/api/login", "POST", {
                  password,
                });
                setPassword("");
                onSuccess();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={setup ? "new-password" : "current-password"}
                minLength={12}
                maxLength={128}
                required
                autoFocus
              />
            </label>
            {setup && (
              <span className="field-note">At least 12 characters.</span>
            )}
            <Alert text={error} />
            <button className="primary full" disabled={busy}>
              {busy ? (
                <Busy />
              ) : setup ? (
                "Create my library"
              ) : (
                "Open my library"
              )}
              <ArrowUpRight size={16} />
            </button>
          </form>
        )}
        <div className="privacy">
          <ShieldCheck size={15} /> Private to your account
        </div>
      </div>
    </main>
  );
}
function Consent({ id }: { id: string }) {
  const [request, setRequest] = useState<{
      clientName: string;
      scopes: string[];
      redirectUri: string;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<typeof request>(`/api/authorize/${encodeURIComponent(id)}`)
      .then(setRequest)
      .catch((e) => setError(message(e)));
  }, [id]);
  const respond = async (approved: boolean) => {
    setBusy(true);
    try {
      const result = await api<{ redirect: string }>(
        `/api/authorize/${encodeURIComponent(id)}`,
        "POST",
        { approved },
      );
      location.assign(result.redirect);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <main className="auth-shell">
      <Brand />
      <div className="auth-form">
        <PlugZap size={28} />
        <h1>Connect your library</h1>
        <Alert text={error} />
        {request ? (
          <>
            <p>
              <strong>{request.clientName}</strong> is requesting access to Drop
              It.
            </p>
            <ul className="permissions">
              {request.scopes.map((scope) => (
                <li key={scope}>
                  {scope === "library:read"
                    ? "Read your saved items and sources"
                    : "Save, edit, and delete library items"}
                </li>
              ))}
            </ul>
            <p className="field-note">
              Return to {new URL(request.redirectUri).host}
            </p>
            <div className="actions">
              <button disabled={busy} onClick={() => void respond(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void respond(true)}
              >
                {busy ? <Busy /> : "Connect"}
              </button>
            </div>
          </>
        ) : (
          !error && <Busy />
        )}
      </div>
    </main>
  );
}

function Library({ onLogout }: { onLogout: () => void }) {
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [category, setCategory] = useState("");
  const [data, setData] = useState<SearchResult>({
      items: [],
      total: 0,
      counts: {},
      categories: [],
      aiAvailable: false,
      mode: "keyword",
    }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [offset, setOffset] = useState(0),
    [tick, setTick] = useState(0),
    [notice, setNotice] = useState("");
  const refresh = useCallback(() => setTick((v) => v + 1), []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      () => {
        setLoading(true);
        setError("");
        client
          .search({
            query,
            mode: "hybrid",
            status: (status as Item["status"]) || undefined,
            category: (category as Item["category"]) || undefined,
            offset,
            limit: 30,
          })
          .then((value) => {
            if (active) setData(value);
          })
          .catch((e) => {
            if (active) setError(message(e));
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, status, category, offset, tick]);
  useEffect(() => {
    const receive = (event: Event) => {
      const result = (event as CustomEvent).detail;
      if (result?.item?.id) {
        setSelected(result.item.id);
        refresh();
      } else if (result?.deleted) refresh();
    };
    window.addEventListener("dropit:result", receive);
    return () => window.removeEventListener("dropit:result", receive);
  }, [refresh]);
  const changeStatus = (value: string) => {
    setStatus(value);
    setOffset(0);
  };
  const signOut = async () => {
    try {
      await api("/api/logout", "POST", {});
      onLogout();
    } catch (e) {
      setError(message(e));
    }
  };
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  return (
    <div className={`app ${embedded ? "embedded" : ""}`}>
      <aside className="sidebar">
        <Brand />
        <span className="sidebar-label">LIBRARY</span>
        <nav aria-label="Library views">
          <button
            className={!status ? "nav-item active" : "nav-item"}
            onClick={() => changeStatus("")}
          >
            <Inbox size={18} />
            All drops<span>{total}</span>
          </button>
          {statuses.map((value) => {
            const Icon = icons[value];
            return (
              <button
                key={value}
                className={`nav-item ${status === value ? "active" : ""}`}
                onClick={() => changeStatus(value)}
              >
                <Icon size={17} />
                {value}
                <span>{data.counts[value] ?? 0}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <span className="private-label">
            <ShieldCheck size={15} />
            Personal library
          </span>
          {!embedded && (
            <button className="nav-item" onClick={signOut}>
              <LogOut size={16} />
              Sign out
            </button>
          )}
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <span className="breadcrumb">
            Library <span>/</span> <strong>{status || "All drops"}</strong>
          </span>
          <div className="top-actions">
            {!embedded && (
              <>
                <button
                  className="icon-button"
                  title="Disconnect all MCP clients"
                  aria-label="Disconnect all MCP clients"
                  onClick={async () => {
                    if (
                      !confirm(
                        "Disconnect ChatGPT and other MCP clients? Your library will remain saved.",
                      )
                    )
                      return;
                    try {
                      await api("/api/revoke-connections", "POST", {});
                      setNotice("Connections revoked.");
                    } catch (e) {
                      setError(message(e));
                    }
                  }}
                >
                  <PlugZap size={17} />
                </button>
                <a
                  className="icon-button"
                  href="/api/export"
                  title="Export library"
                  aria-label="Export library"
                >
                  <ArrowDownToLine size={17} />
                </a>
              </>
            )}
            <button
              className="primary"
              title="New drop"
              aria-label="New drop"
              onClick={() => setAdding(true)}
            >
              <Plus size={17} />
              <span className="new-drop-label">New drop</span>
            </button>
          </div>
        </header>
        <section className="library-content">
          <div className="section-heading">
            <div>
              <h1>
                {status || "All drops"}
                <span className="heading-count">{data.total}</span>
              </h1>
            </div>
            <span className="saved-caption">Good things, kept.</span>
          </div>
          {query && data.searchNotice && !loading && !error && (
            <p className="field-note" role="status">
              {data.searchNotice}
            </p>
          )}
          <form
            className="filters"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(searchDraft.trim());
              setOffset(0);
              refresh();
            }}
          >
            <label className="search">
              <Search size={18} />
              <input
                aria-label="Search your library"
                placeholder="What do you want to find?"
                title="Search by words and meaning. AI search processes your query and saved drop text with OpenAI."
                value={searchDraft}
                maxLength={300}
                onChange={(e) => {
                  setSearchDraft(e.target.value);
                }}
              />
              {searchDraft && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery("");
                    setSearchDraft("");
                    setOffset(0);
                  }}
                >
                  <X size={15} />
                </button>
              )}
              <button
                className="icon-button"
                type="submit"
                aria-label="Run search"
                title="Search"
                disabled={loading}
              >
                <ArrowRight size={17} />
              </button>
            </label>
            <label className="select-wrap">
              <select
                aria-label="Category"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">All categories</option>
                {[
                  ...new Set([
                    ...data.categories,
                    ...(category ? [category] : []),
                  ]),
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="select-wrap mobile-status">
              <select
                aria-label="Status"
                value={status}
                onChange={(e) => changeStatus(e.target.value)}
              >
                <option value="">All statuses</option>
                {statuses.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
          </form>
          <Alert text={error} />
          {error && <button onClick={refresh}>Retry</button>}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {loading ? (
            <div className="loading">
              <Busy />
            </div>
          ) : error ? null : data.items.length ? (
            <>
              <div className="list-labels">
                <span>SAVED ITEM</span>
                <span>STATUS</span>
                <span>ADDED</span>
              </div>
              <div className="item-list">
                {data.items.map((item) => (
                  <button
                    key={item.id}
                    className="item-row"
                    onClick={() => setSelected(item.id)}
                  >
                    <span
                      className={`item-icon ${categoryTone(item.category)}`}
                    >
                      {item.hasImage ? (
                        <ImageIcon size={21} />
                      ) : item.sourceUrl ? (
                        <LinkIcon size={21} />
                      ) : (
                        <FileText size={21} />
                      )}
                    </span>
                    <span className="item-copy">
                      <span className="item-title">{item.title}</span>
                      <span className="item-summary">
                        {item.summary || item.notes || "No summary"}
                      </span>
                      <span className="tags">
                        <span
                          className={`category-tag ${categoryTone(item.category)}`}
                        >
                          {item.category}
                        </span>
                        {item.tags.slice(0, 3).map((tag) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </span>
                    </span>
                    <span
                      className={`status status-${item.status.toLowerCase().replace(" ", "-")}`}
                    >
                      <Circle size={7} fill="currentColor" />
                      {item.status}
                    </span>
                    <span className="item-date">{date(item.createdAt)}</span>
                    <ArrowUpRight className="row-arrow" size={16} />
                  </button>
                ))}
              </div>
              <div className="pagination">
                <span>
                  {offset + 1}-{Math.min(offset + 30, data.total)} of{" "}
                  {data.total}
                </span>
                <div className="actions">
                  <button
                    disabled={offset === 0}
                    onClick={() => setOffset((v) => Math.max(0, v - 30))}
                  >
                    Previous
                  </button>
                  <button
                    disabled={offset + 30 >= data.total}
                    onClick={() => setOffset((v) => v + 30)}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="empty">
              <span className="empty-icon">
                <FolderOpen size={32} />
              </span>
              <h2>
                {total
                  ? "Nothing here just yet."
                  : "Your next good idea goes here."}
              </h2>
              <p>
                {total
                  ? "No saved items match this view."
                  : "Keep the link. Save the screenshot. Come back to it."}
              </p>
              <button
                className="primary"
                onClick={() =>
                  total
                    ? (setQuery(""), setCategory(""), changeStatus(""))
                    : setAdding(true)
                }
              >
                {total ? (
                  "Clear filters"
                ) : (
                  <>
                    <Plus size={16} />
                    Save your first drop
                  </>
                )}
              </button>
            </div>
          )}
        </section>
        <footer className="footer">
          <span>drop it. pick it up later.</span>
          <span>
            <span className="online-dot" />
            Private library
            {!embedded && (
              <button
                className="icon-button mobile-signout"
                title="Sign out"
                aria-label="Sign out"
                onClick={signOut}
              >
                <LogOut size={15} />
              </button>
            )}
          </span>
        </footer>
      </main>
      {adding && (
        <Capture
          categories={data.categories}
          aiAvailable={data.aiAvailable}
          onClose={() => setAdding(false)}
          onSaved={(item) => {
            setAdding(false);
            refresh();
            setSelected(item.id);
          }}
        />
      )}
      {selected && !adding && (
        <Detail
          categories={data.categories}
          key={selected}
          id={selected}
          onClose={() => setSelected(null)}
          onChange={refresh}
        />
      )}
    </div>
  );
}

function Panel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="panel"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-label={title}
    >
      <div className="panel-header">
        <span>{title}</span>
        <button
          className="icon-button"
          aria-label="Close panel"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Capture({
  onClose,
  onSaved,
  categories,
  aiAvailable,
}: {
  onClose: () => void;
  onSaved: (item: Item) => void;
  categories: string[];
  aiAvailable: boolean;
}) {
  const [title, setTitle] = useState(""),
    [summary, setSummary] = useState(""),
    [text, setText] = useState(""),
    [url, setUrl] = useState(""),
    [tags, setTags] = useState(""),
    [category, setCategory] = useState(""),
    [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [duplicate, setDuplicate] = useState(false);
  const [drafted, setDrafted] = useState(false),
    [drafting, setDrafting] = useState(false);
  const [manual, setManual] = useState(false);
  const upload = useRef<{
    file: File;
    id: string;
    originalText: string;
  } | null>(null);
  const attempt = useRef<{ signature: string; requestId: string } | null>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const pick = (next: File | undefined) => {
    if (busy) return;
    if (!next) return;
    if (!fileMime(next.name) || !next.size || next.size > maxFileBytes) {
      setError(
        "Choose an image, PDF, TXT, Markdown, CSV, or JSON file under 10 MB.",
      );
      return;
    }
    setFile(next);
    setPreview(
      isImageMime(fileMime(next.name) ?? "") ? URL.createObjectURL(next) : "",
    );
    setError("");
    if (!manual) {
      setDrafted(false);
      setTitle("");
      setSummary("");
      setCategory("");
      setTags("");
      setText("");
      setUrl("");
      if (aiAvailable) void draft(next);
    }
  };
  const sourceInput = async (selected = file, fileOnly = false) => {
    if (selected && upload.current?.file !== selected) {
      const result = await client.upload(selected);
      upload.current = {
        file: selected,
        id: result.attachmentId,
        originalText: result.originalText,
      };
    }
    return {
      originalText:
        (fileOnly ? "" : text) ||
        (selected ? (upload.current?.originalText ?? "") : ""),
      url: fileOnly ? "" : url,
      attachmentId: selected ? upload.current?.id : undefined,
    };
  };
  const draft = async (sourceFile?: File) => {
    setBusy(true);
    setDrafting(true);
    setError("");
    setDuplicate(false);
    try {
      const selected = sourceFile ?? file;
      const { draft } = await client.draft(
        await sourceInput(selected, Boolean(sourceFile)),
      );
      setTitle(draft.title);
      setSummary(draft.summary);
      setCategory(draft.category);
      setTags(draft.tags.join(", "));
      if (sourceFile || !text.trim())
        setText(
          (selected ? upload.current?.originalText : "") || draft.extractedText,
        );
      if (sourceFile || !url.trim()) setUrl(draft.sourceUrl);
      setDrafted(true);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
      setDrafting(false);
    }
  };
  const save = async (allowDuplicate = false) => {
    setBusy(true);
    setError("");
    try {
      const source = await sourceInput();
      const fields = {
        title,
        summary,
        category: category.trim() || undefined,
        tags: tags
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        notes,
        source,
        allowDuplicate,
      };
      const signature = JSON.stringify(fields);
      if (attempt.current?.signature !== signature)
        attempt.current = { signature, requestId: crypto.randomUUID() };
      const result = await client.save({
        ...fields,
        requestId: attempt.current.requestId,
      } satisfies SaveInput);
      onSaved(result.item);
    } catch (e) {
      setError(message(e));
      setDuplicate(e instanceof ClientError && e.code === "DUPLICATE");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="New drop"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="panel-body capture"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual || drafted) void save();
        }}
      >
        <fieldset disabled={busy} className="capture-fields">
          <label
            className={`upload-area ${file ? "has-file" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              pick(e.dataTransfer.files[0]);
            }}
          >
            {file && preview ? (
              <img src={preview} alt="Selected image" />
            ) : (
              <>
                <FileText size={27} />
                <span>{file ? file.name : "Drop a file"}</span>
                <span className="field-note">
                  Images, PDF, TXT, Markdown, CSV, JSON · Up to 10 MB
                </span>
              </>
            )}
            <input
              type="file"
              accept={fileAccept}
              aria-label="Drop a file"
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </label>
          {file && (
            <div className="file-label">
              <span>{file.name}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Remove file"
                onClick={() => {
                  setFile(null);
                  setPreview("");
                  upload.current = null;
                  if (!manual) {
                    setDrafted(false);
                    setTitle("");
                    setSummary("");
                    setCategory("");
                    setTags("");
                    setText("");
                    setUrl("");
                  }
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {!manual && (
            <>
              {drafting && (
                <div className="draft-actions" role="status">
                  <Busy />
                  <span>Drafting...</span>
                </div>
              )}
              {drafted && (
                <section className="draft-preview" aria-label="File draft">
                  <span className="field-note">AI draft · Not saved</span>
                  <h3>{title}</h3>
                  <p>{summary}</p>
                  <span className="field-note">
                    {[category, ...tags.split(", ")]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </section>
              )}
              {drafted && (
                <label>
                  Source link
                  <input
                    type="url"
                    value={url}
                    placeholder="https://"
                    maxLength={2048}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </label>
              )}
              <div className="draft-actions">
                <button type="button" onClick={() => setManual(true)}>
                  Enter manually
                </button>
                {file && !drafted && !drafting && aiAvailable && (
                  <button type="button" onClick={() => void draft(file)}>
                    <Sparkles size={16} />
                    Retry draft
                  </button>
                )}
              </div>
              {!drafted && !drafting && (
                <span className="field-note">
                  {aiAvailable
                    ? "Files are processed with OpenAI. PDFs: up to 30 pages. Text: up to 50,000 characters."
                    : "AI is unavailable. Enter details manually."}
                </span>
              )}
            </>
          )}
          {manual && (
            <>
              <label>
                Source link
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://"
                  maxLength={2048}
                />
              </label>
              <label>
                Text / file transcription
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste a passage, a quick idea, or source text..."
                  maxLength={50000}
                  rows={4}
                />
              </label>
              <div className="draft-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void draft()}
                  disabled={
                    !aiAvailable || (!text.trim() && !url.trim() && !file)
                  }
                >
                  {drafting ? <Busy /> : <Sparkles size={16} />}
                  {drafting ? "Drafting..." : "Draft with AI"}
                </button>
                <span className="field-note">
                  {!aiAvailable
                    ? "AI is not configured."
                    : drafted
                      ? "AI draft · Not saved"
                      : "Processes this source with OpenAI."}
                </span>
              </div>
              <label>
                Title
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Something worth coming back to"
                  required
                  maxLength={200}
                />
              </label>
              <label>
                Summary
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  maxLength={4000}
                  rows={2}
                />
              </label>
              <div className="form-grid">
                <CategoryField
                  value={category}
                  onChange={setCategory}
                  categories={categories}
                />
                <label>
                  Tags
                  <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="python, weekend"
                    maxLength={480}
                  />
                </label>
              </div>
              <label>
                Why I saved this
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={8000}
                  rows={2}
                />
              </label>
            </>
          )}
          <Alert text={error} />
          {duplicate && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(true)}
            >
              Save another copy
            </button>
          )}
          <div className="panel-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            {(manual || drafted) && (
              <button className="primary" disabled={busy}>
                {busy ? <Busy /> : <Bookmark size={16} />}Save drop
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </Panel>
  );
}

function Detail({
  id,
  onClose,
  onChange,
  categories,
}: {
  id: string;
  onClose: () => void;
  onChange: () => void;
  categories: string[];
}) {
  const [detail, setDetail] = useState<{
      item: Item;
      source: Source;
      imageData?: string;
      fileData?: string;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [notes, setNotes] = useState(""),
    [title, setTitle] = useState(""),
    [summary, setSummary] = useState(""),
    [tags, setTags] = useState(""),
    [category, setCategory] = useState("");
  const load = useCallback(() => {
    client
      .get(id)
      .then((result) => {
        setDetail(result);
        setNotes(result.item.notes);
        setTitle(result.item.title);
        setSummary(result.item.summary);
        setTags(result.item.tags.join(", "));
        setCategory(result.item.category);
        setError("");
      })
      .catch((e) => setError(message(e)));
  }, [id]);
  useEffect(load, [load]);
  const update = async (fields: Record<string, unknown>) => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const result = await client.update(id, {
        revision: detail.item.revision,
        ...fields,
      });
      setDetail({
        ...result,
        imageData: detail.imageData,
        fileData: detail.fileData,
      });
      setEditing(false);
      onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Saved item"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="panel-body">
        <Alert text={error} />
        {error && <button onClick={load}>Reload item</button>}
        {!detail ? (
          !error && <Busy />
        ) : (
          <>
            <div className="detail-meta">
              <span
                className={`category-tag ${categoryTone(detail.item.category)}`}
              >
                {detail.item.category}
              </span>
              <span>Saved {date(detail.item.createdAt)}</span>
              <button
                className="icon-button"
                aria-label="Edit item"
                title="Edit item"
                onClick={() => setEditing((v) => !v)}
              >
                <Pencil size={16} />
              </button>
            </div>
            {editing ? (
              <form
                className="edit-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void update({
                    title,
                    summary,
                    tags: tags
                      .split(",")
                      .map((v) => v.trim())
                      .filter(Boolean),
                    category: category.trim() || "Uncategorized",
                  });
                }}
              >
                <label>
                  Title
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    required
                  />
                </label>
                <label>
                  Summary
                  <textarea
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    maxLength={4000}
                  />
                </label>
                <CategoryField
                  value={category}
                  onChange={setCategory}
                  categories={categories}
                />
                <label>
                  Tags
                  <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    maxLength={480}
                  />
                </label>
                <button className="primary" disabled={busy}>
                  Save changes
                </button>
              </form>
            ) : (
              <>
                <h2 className="detail-title">{detail.item.title}</h2>
                {detail.item.summary && (
                  <p className="detail-summary">{detail.item.summary}</p>
                )}
                <div className="tags">
                  {detail.item.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
              </>
            )}
            <label className="status-field">
              Status
              <select
                disabled={busy}
                value={detail.item.status}
                onChange={(e) => void update({ status: e.target.value })}
              >
                {statuses.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <div className="detail-section">
              <h3>
                <Bookmark size={15} />
                My notes
              </h3>
              <textarea
                aria-label="My notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                maxLength={8000}
                placeholder="Why it matters. What happened next."
              />
              <button
                disabled={busy || notes === detail.item.notes}
                onClick={() => void update({ notes })}
              >
                Save notes
              </button>
            </div>
            <div className="detail-section">
              <h3>
                <FileText size={15} />
                Original source
              </h3>
              {detail.source.url && (
                <a
                  className="source-link"
                  href={detail.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <LinkIcon size={15} />
                  <span>{detail.source.url}</span>
                  <ArrowUpRight size={15} />
                </a>
              )}
              {detail.source.hasImage &&
                (embedded ? detail.imageData : <></>) !== undefined && (
                  <img
                    className="source-image"
                    src={
                      embedded
                        ? detail.imageData
                        : `/api/sources/${detail.source.id}/image`
                    }
                    alt="Original saved screenshot"
                  />
                )}
              {detail.source.originalText && (
                <pre className="source-text">{detail.source.originalText}</pre>
              )}
              {detail.source.hasFile &&
                (!embedded || detail.fileData || detail.imageData) && (
                  <a
                    className="source-link"
                    href={
                      embedded
                        ? (detail.fileData ?? detail.imageData)
                        : `/api/sources/${detail.source.id}/file`
                    }
                    download={detail.source.filename ?? "source"}
                  >
                    <ArrowDownToLine size={15} />
                    <span>{detail.source.filename ?? "Download original"}</span>
                  </a>
                )}
              {!detail.source.url &&
                !detail.source.hasFile &&
                !detail.source.originalText && (
                  <p className="muted">No source attached.</p>
                )}
            </div>
            <div className="delete-area">
              {confirmDelete ? (
                <>
                  <p>
                    Delete this drop? Its source is removed when no other drops
                    use it.
                  </p>
                  <div className="actions">
                    <button
                      disabled={busy}
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep it
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await client.delete(id, detail.item.revision);
                          onChange();
                          onClose();
                        } catch (e) {
                          setError(message(e));
                          setBusy(false);
                        }
                      }}
                    >
                      Delete drop
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="text-danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={15} />
                  Delete drop
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
