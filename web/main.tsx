import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useId,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownToLine,
  Droplet,
  Sparkles,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  ChevronDown,
  RotateCcw,
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
  Settings,
} from "lucide-react";
import {
  views,
  type Item,
  type Source,
  type SaveInput,
  type SearchResult,
  settingsSchema,
  type LibrarySettings,
} from "../shared/schema.js";
import {
  api,
  browserRequest,
  client,
  ClientError,
  embedded,
} from "./client.js";
import { RecoveryForm, SecuritySettings } from "./security.js";
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
      Pool
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        list={id}
        maxLength={60}
        placeholder="Pool name"
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
  "All drops": Inbox,
  Saved: Bookmark,
  Trash: Trash2,
};
function SaveRibbon({
  saved,
  disabled,
  onClick,
}: {
  saved: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`icon-button save-ribbon ${saved ? "is-saved" : ""}`}
      aria-label={saved ? "Unsave drop" : "Save drop"}
      title={saved ? "Unsave drop" : "Save for later"}
      aria-pressed={saved}
      disabled={disabled}
      onClick={onClick}
    >
      <Bookmark size={20} fill={saved ? "currentColor" : "none"} />
    </button>
  );
}
const deletionDate = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
    publicAccounts?: boolean;
    signupEnabled?: boolean;
  } | null>(
    embedded
      ? { authenticated: true, needsSetup: false, localSetup: false }
      : null,
  );
  const [error, setError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const sessionRequest = useRef(0);
  const refresh = useCallback(() => {
    const request = ++sessionRequest.current;
    api<typeof session>("/api/session")
      .then((value) => {
        if (request === sessionRequest.current) setSession(value);
      })
      .catch((e) => {
        if (request === sessionRequest.current) setError(message(e));
      });
  }, []);
  useEffect(() => {
    if (embedded) return;
    const sessionEnded = () => {
      // Ignore earlier session checks that may have completed before revocation.
      sessionRequest.current++;
      setError("");
      setAuthNotice(
        "Your browser session has ended. Sign in again to continue.",
      );
      setSession((value) => ({
        authenticated: false,
        needsSetup: false,
        localSetup: value?.localSetup ?? false,
        publicAccounts: value?.publicAccounts,
        signupEnabled: value?.signupEnabled,
      }));
    };
    window.addEventListener("dropit:unauthenticated", sessionEnded);
    refresh();
    return () => {
      window.removeEventListener("dropit:unauthenticated", sessionEnded);
    };
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
        publicAccounts={session.publicAccounts ?? false}
        signupEnabled={session.signupEnabled ?? false}
        notice={authNotice}
        onSuccess={() => {
          setAuthNotice("");
          refresh();
        }}
      />
    );
  const authorization = new URLSearchParams(location.search).get("authorize");
  if (authorization && !embedded) return <Consent id={authorization} />;
  return (
    <Library
      onLogout={(notice = "") => {
        setAuthNotice(notice);
        setSession((value) =>
          value ? { ...value, authenticated: false } : value,
        );
        refresh();
      }}
    />
  );
}
function Login({
  setup,
  local,
  publicAccounts,
  signupEnabled,
  notice,
  onSuccess,
}: {
  setup: boolean;
  local: boolean;
  publicAccounts: boolean;
  signupEnabled: boolean;
  notice: string;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [recovering, setRecovering] = useState(false),
    [recoveryNotice, setRecoveryNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const loginLock = useRef(false);
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const creating = setup || registering;
  return (
    <main className="auth-shell">
      <Brand />
      <div className="auth-form">
        {recovering && !setup ? (
          <RecoveryForm
            onCancel={() => setRecovering(false)}
            onRecovered={() => {
              setRecovering(false);
              setPassword("");
              setRecoveryNotice(
                "Password reset. Sign in with your new password, then generate a new recovery code in Settings.",
              );
            }}
          />
        ) : (
          <>
            <span className="eyebrow">YOUR PRIVATE LIBRARY</span>
            <h1>{creating ? "Make a little room." : "Welcome back."}</h1>
            <p className="muted">
              {creating
                ? "A place for the things worth keeping."
                : "Your saved ideas are right where you left them."}
            </p>
            {(recoveryNotice || notice) && (
              <p className="settings-notice" role="status">
                {recoveryNotice || notice}
              </p>
            )}
            {setup && !local ? (
              <Alert text="Open Drop It locally to create the owner account." />
            ) : (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (loginLock.current) return;
                  if (creating && password !== confirmation) {
                    setError("The passwords do not match.");
                    return;
                  }
                  loginLock.current = true;
                  setBusy(true);
                  setError("");
                  try {
                    await api(
                      registering
                        ? "/api/register"
                        : setup
                          ? "/api/setup"
                          : "/api/login",
                      "POST",
                      {
                        password,
                        ...(publicAccounts ? { username } : {}),
                      },
                    );
                    onSuccess();
                  } catch (e) {
                    setError(message(e));
                  } finally {
                    setPassword("");
                    setConfirmation("");
                    loginLock.current = false;
                    setBusy(false);
                  }
                }}
              >
                {publicAccounts && (
                  <label>
                    Username
                    <input
                      name="username"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      minLength={3}
                      maxLength={40}
                      pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
                      required
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      disabled={busy}
                    />
                    <span className="field-note">
                      Use 3–40 letters, numbers, underscores or hyphens. Your
                      username is private.
                    </span>
                  </label>
                )}
                {registering && (
                  <p className="field-note">
                    No email is collected. After signing up, save a recovery
                    code from Settings so you can recover a forgotten password.
                  </p>
                )}
                <label>
                  Password
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={
                      creating ? "new-password" : "current-password"
                    }
                    minLength={creating ? 15 : 1}
                    maxLength={128}
                    required
                    autoFocus
                    disabled={busy}
                  />
                </label>
                {creating && (
                  <>
                    <span className="field-note">
                      At least 15 characters. Use a unique passphrase.
                    </span>
                    <label>
                      Confirm password
                      <input
                        type="password"
                        autoComplete="new-password"
                        minLength={15}
                        maxLength={128}
                        required
                        disabled={busy}
                        value={confirmation}
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                      />
                    </label>
                  </>
                )}
                <Alert text={error} />
                <button className="primary full" disabled={busy}>
                  {busy ? (
                    <Busy />
                  ) : creating ? (
                    "Create my library"
                  ) : (
                    "Open my library"
                  )}
                  <ArrowUpRight size={16} />
                </button>
                {!creating && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPassword("");
                      setConfirmation("");
                      setError("");
                      setRecovering(true);
                    }}
                  >
                    Forgot password?
                  </button>
                )}
                {publicAccounts && signupEnabled && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setRegistering((value) => !value);
                      setError("");
                      setPassword("");
                      setConfirmation("");
                    }}
                  >
                    {registering
                      ? "Already have an account? Sign in"
                      : "Create an account"}
                  </button>
                )}
              </form>
            )}
          </>
        )}
        <div className="privacy">
          <ShieldCheck size={15} /> Private to your account
        </div>
        {publicAccounts && (
          <nav className="privacy" aria-label="Product information">
            <a href="/about">About</a>
            <a href="/support">Support</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </nav>
        )}
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

function Library({ onLogout }: { onLogout: (notice?: string) => void }) {
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState(""),
    [view, setView] = useState<(typeof views)[number]>("All drops"),
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
    [settingsOpen, setSettingsOpen] = useState(false);
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
            view,
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
  }, [query, view, category, offset, tick]);
  useEffect(() => {
    const receive = (event: Event) => {
      const result = (event as CustomEvent).detail;
      if (result?.item?.id) {
        setSelected(result.item.id);
        refresh();
      } else if (result?.trashed) {
        setSelected(null);
        refresh();
      }
    };
    window.addEventListener("dropit:result", receive);
    return () => window.removeEventListener("dropit:result", receive);
  }, [refresh]);
  const changeView = (value: (typeof views)[number]) => {
    setView(value);
    setOffset(0);
  };
  const [bookmarkBusy, setBookmarkBusy] = useState<string | null>(null);
  const bookmarkLock = useRef(false);
  const toggleBookmark = async (item: Item) => {
    if (bookmarkLock.current) return;
    bookmarkLock.current = true;
    setBookmarkBusy(item.id);
    try {
      await client.update(item.id, {
        revision: item.revision,
        isSaved: !item.isSaved,
      });
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      bookmarkLock.current = false;
      setBookmarkBusy(null);
    }
  };
  const signOut = async () => {
    try {
      await api("/api/logout", "POST", {});
      onLogout();
    } catch (e) {
      setError(message(e));
    }
  };
  const total = (data.counts["All drops"] ?? 0) + (data.counts.Trash ?? 0);
  return (
    <div className={`app ${embedded ? "embedded" : ""}`}>
      <aside className="sidebar">
        <Brand />
        <span className="sidebar-label">LIBRARY</span>
        <nav aria-label="Library views">
          {views.map((value) => {
            const Icon = icons[value];
            return (
              <button
                key={value}
                className={`nav-item ${view === value ? "active" : ""}`}
                onClick={() => changeView(value)}
              >
                <Icon
                  size={17}
                  className={value === "Trash" ? "trash-nav-icon" : undefined}
                />
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
            Library <span>/</span> <strong>{view}</strong>
          </span>
          <div className="top-actions">
            {!embedded && (
              <button
                className="icon-button"
                title="Settings"
                aria-label="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={18} />
              </button>
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
                {view}
                <span className="heading-count">{data.total}</span>
              </h1>
            </div>
            <span className="saved-caption">Good things, kept.</span>
          </div>
          {view === "Trash" && (
            <p className="trash-notice">
              Drops in Trash are permanently deleted after 7 days.
            </p>
          )}
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
                aria-label="Pool"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">All pools</option>
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
            <label className="select-wrap mobile-view">
              <select
                aria-label="Library view"
                value={view}
                onChange={(e) =>
                  changeView(e.target.value as (typeof views)[number])
                }
              >
                {views.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
          </form>
          <Alert text={error} />
          {error && <button onClick={refresh}>Retry</button>}
          {loading ? (
            <div className="loading">
              <Busy />
            </div>
          ) : error ? null : data.items.length ? (
            <>
              <div className="list-labels">
                <span>DROP</span>
                <span>{view === "Trash" ? "DELETES" : "CREATED"}</span>
                <span>{view === "Trash" ? "" : "SAVED"}</span>
              </div>
              <div className="item-list">
                {data.items.map((item) => (
                  <div key={item.id} className="item-row">
                    <button
                      className="item-open"
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
                        className="item-date"
                        title={
                          item.deleteAfter
                            ? deletionDate(item.deleteAfter)
                            : undefined
                        }
                      >
                        {date(item.deleteAfter ?? item.createdAt)}
                      </span>
                      <ArrowUpRight className="row-arrow" size={16} />
                    </button>
                    {!item.trashedAt && (
                      <SaveRibbon
                        saved={item.isSaved}
                        disabled={bookmarkBusy !== null}
                        onClick={() => void toggleBookmark(item)}
                      />
                    )}
                  </div>
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
                  ? "No drops match this view."
                  : "Keep the link. Save the screenshot. Come back to it."}
              </p>
              <button
                className="primary"
                onClick={() =>
                  total
                    ? (setQuery(""), setCategory(""), changeView("All drops"))
                    : setAdding(true)
                }
              >
                {total ? (
                  "Clear filters"
                ) : (
                  <>
                    <Plus size={16} />
                    Create your first drop
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
      {settingsOpen && !embedded && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onSignedOut={(notice) => {
            setSettingsOpen(false);
            onLogout(notice);
          }}
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
  useLayoutEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
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
function SettingsPanel({
  onClose,
  onSignedOut,
}: {
  onClose: () => void;
  onSignedOut: (notice: string) => void;
}) {
  const [settings, setSettings] = useState<LibrarySettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"export" | "disconnect" | "security" | null>(
    null,
  );
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const actionLock = useRef(false);
  const cancelDisconnect = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmDisconnect) cancelDisconnect.current?.focus();
  }, [confirmDisconnect]);
  useEffect(() => {
    let active = true;
    api<unknown>("/api/settings")
      .then((result) => {
        const parsed = settingsSchema.parse(result);
        if (active) {
          setSettings(parsed);
          setLoadError("");
        }
      })
      .catch(() => {
        if (active) setLoadError("Settings could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  const exportLibrary = async () => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy("export");
    setError("");
    setNotice("");
    try {
      const response = await browserRequest("/api/export");
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("application/json")
      )
        throw new Error("Export failed. Check your connection and try again.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "drop-it-library.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice("Library download started.");
    } catch {
      setError("Export failed. Check your connection and try again.");
    } finally {
      actionLock.current = false;
      setBusy(null);
    }
  };
  const disconnect = async () => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy("disconnect");
    setError("");
    setNotice("");
    try {
      await api("/api/revoke-connections", "POST", {});
      setSettings((value) => (value ? { ...value, connectedApps: 0 } : value));
      setConfirmDisconnect(false);
      setNotice("App connections disconnected. Your library is unchanged.");
    } catch {
      setError("Could not disconnect apps. Please try again.");
    } finally {
      actionLock.current = false;
      setBusy(null);
    }
  };
  return (
    <Panel
      title="Settings"
      onClose={() => {
        if (!actionLock.current) onClose();
      }}
    >
      <div className="panel-body settings-body">
        <Alert text={error} />
        {notice && (
          <p className="settings-notice" role="status">
            {notice}
          </p>
        )}
        <SecuritySettings
          disabled={busy !== null}
          beginAction={() => {
            if (actionLock.current) return false;
            actionLock.current = true;
            setBusy("security");
            setError("");
            setNotice("");
            return true;
          }}
          endAction={() => {
            actionLock.current = false;
            setBusy(null);
          }}
          onSignedOut={onSignedOut}
        />
        <section className="settings-section" aria-labelledby="settings-data">
          <h3 id="settings-data">
            <ArrowDownToLine size={17} />
            Data
          </h3>
          <p>
            A private JSON copy of your drops, notes, bookmarks and original
            files, including unexpired Trash.
          </p>
          <button disabled={busy !== null} onClick={() => void exportLibrary()}>
            {busy === "export" ? <Busy /> : <ArrowDownToLine size={16} />}
            {busy === "export" ? "Exporting..." : "Export library"}
          </button>
        </section>
        <Alert text={loadError} />
        {loadError && (
          <button
            onClick={() => {
              setLoadError("");
              setAttempt((value) => value + 1);
            }}
          >
            <RotateCcw size={16} />
            Retry settings
          </button>
        )}
        {!settings && !loadError && (
          <div className="settings-loading" role="status">
            <Busy />
            Loading settings
          </div>
        )}
        <section
          className="settings-section"
          aria-labelledby="settings-connections"
        >
          <h3 id="settings-connections">
            <PlugZap size={17} />
            Connections
          </h3>
          <p>
            {settings
              ? settings.connectedApps === 0
                ? "No connected apps."
                : `${settings.connectedApps} connected ${settings.connectedApps === 1 ? "app" : "apps"}.`
              : "Connection status unavailable."}
          </p>
          <p>
            Disconnecting revokes existing ChatGPT and other app access. Your
            drops and this browser session stay intact.
          </p>
          {confirmDisconnect ? (
            <div className="settings-confirm">
              <p>Disconnect all apps? They will need approval to reconnect.</p>
              <div className="actions">
                <button
                  ref={cancelDisconnect}
                  disabled={busy !== null}
                  onClick={() => setConfirmDisconnect(false)}
                >
                  Cancel
                </button>
                <button
                  className="danger"
                  disabled={busy !== null}
                  onClick={() => void disconnect()}
                >
                  {busy === "disconnect" ? <Busy /> : <PlugZap size={16} />}
                  {busy === "disconnect"
                    ? "Disconnecting..."
                    : "Disconnect all"}
                </button>
              </div>
            </div>
          ) : (
            <button
              disabled={busy !== null || !settings?.connectedApps}
              onClick={() => setConfirmDisconnect(true)}
            >
              <PlugZap size={16} />
              Disconnect all apps
            </button>
          )}
        </section>
        <section className="settings-section" aria-labelledby="settings-ai">
          <h3 id="settings-ai">
            <Sparkles size={17} />
            AI &amp; privacy
          </h3>
          <dl className="settings-facts">
            <div>
              <dt>OpenAI</dt>
              <dd>
                {settings
                  ? settings.aiConfigured
                    ? "Configured"
                    : "Not configured"
                  : "Unknown"}
              </dd>
            </div>
          </dl>
          <p>
            Drafting sends the selected source text, link and image or PDF
            content to OpenAI. Search sends your query and portions of matching
            drops, including notes and transcription.
          </p>
          <p>
            API keys stay on the server. Configuration does not confirm API
            access or available credit. OpenAI usage charges and your project’s
            data policies apply.
          </p>
        </section>
        <section className="settings-section" aria-labelledby="settings-trash">
          <h3 id="settings-trash">
            <Trash2 size={17} />
            Trash
          </h3>
          <dl className="settings-facts">
            <div>
              <dt>Retention</dt>
              <dd>7 days · Fixed</dd>
            </div>
          </dl>
          <p>
            Wiped drops can be restored for seven days. After their deadline,
            drops and any unshared source files are permanently deleted.
          </p>
          <p>
            Cleanup runs hourly while the server is running and at startup.
            Restoring a drop cancels its deletion and preserves its bookmark.
          </p>
        </section>
      </div>
    </Panel>
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
                  <span className="field-note">AI draft · Not created</span>
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
                      ? "AI draft · Not created"
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
                My notes
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
              Create another copy
            </button>
          )}
          <div className="panel-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            {(manual || drafted) && (
              <button className="primary" disabled={busy}>
                {busy ? <Busy /> : <Plus size={16} />}Create drop
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
    [showTranscription, setShowTranscription] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const transcriptionId = useId();
  const wipeConfirmation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmDelete) {
      wipeConfirmation.current?.scrollIntoView({ block: "nearest" });
      wipeConfirmation.current?.querySelector("button")?.focus();
    }
  }, [confirmDelete]);
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
      title="Drop"
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
              <span>Created {date(detail.item.createdAt)}</span>
              {!detail.item.trashedAt && (
                <SaveRibbon
                  saved={detail.item.isSaved}
                  disabled={busy}
                  onClick={() => void update({ isSaved: !detail.item.isSaved })}
                />
              )}
              <button
                className="icon-button"
                aria-label="Edit item"
                title="Edit item"
                disabled={busy || Boolean(detail.item.trashedAt)}
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
            {detail.item.deleteAfter && (
              <p className="trash-notice">
                Permanently deletes {deletionDate(detail.item.deleteAfter)}.
              </p>
            )}
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
                <div className="transcription">
                  <button
                    aria-expanded={showTranscription}
                    aria-controls={transcriptionId}
                    onClick={() => setShowTranscription((value) => !value)}
                  >
                    <FileText size={15} />
                    {showTranscription
                      ? "Hide transcription"
                      : "View transcription"}
                  </button>
                  <pre
                    id={transcriptionId}
                    className="source-text"
                    hidden={!showTranscription}
                  >
                    {detail.source.originalText}
                  </pre>
                </div>
              )}
              {detail.source.hasFile &&
                (!embedded || detail.fileData || detail.imageData) &&
                (embedded ? (
                  <button
                    className="source-link"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await client.download(id);
                      } catch (error) {
                        setError(message(error));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <ArrowDownToLine size={15} />
                    <span>{detail.source.filename ?? "Download original"}</span>
                  </button>
                ) : (
                  <a
                    className="source-link"
                    href={`/api/sources/${detail.source.id}/file`}
                    download={detail.source.filename ?? "source"}
                  >
                    <ArrowDownToLine size={15} />
                    <span>{detail.source.filename ?? "Download original"}</span>
                  </a>
                ))}
              {!detail.source.url &&
                !detail.source.hasFile &&
                !detail.source.originalText && (
                  <p className="muted">No source attached.</p>
                )}
            </div>
            <div className="detail-section">
              <h3>
                <Bookmark size={15} />
                My notes
              </h3>
              <textarea
                aria-label="My notes"
                readOnly={Boolean(detail.item.trashedAt)}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                maxLength={8000}
                placeholder="Why it matters. What happened next."
              />
              <button
                disabled={
                  busy ||
                  Boolean(detail.item.trashedAt) ||
                  notes === detail.item.notes
                }
                onClick={() => void update({ notes })}
              >
                Save notes
              </button>
            </div>
            <div className="delete-area" ref={wipeConfirmation}>
              {detail.item.trashedAt ? (
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await client.restore(id, detail.item.revision);
                      onChange();
                      onClose();
                    } catch (e) {
                      setError(message(e));
                      setBusy(false);
                    }
                  }}
                >
                  <RotateCcw size={16} />
                  Restore drop
                </button>
              ) : confirmDelete ? (
                <>
                  <p>
                    Move this drop to Trash? You can restore it for 7 days
                    before it is permanently deleted.
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
                        setError("");
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
                      {busy ? "Wiping..." : "Wipe drop"}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="text-danger"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={15} />
                  Wipe drop
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
