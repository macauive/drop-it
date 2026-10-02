import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useId,
} from "react";
import { createRoot } from "react-dom/client";
import { DropPreview } from "./drop-preview.js";
import { poolTone } from "./pool-colors.js";
import {
  LayoutSwitcher,
  readLayout,
  rememberLayout,
} from "./library-layout.js";
import {
  SidebarToggle,
  readSidebarCollapsed,
  rememberSidebarCollapsed,
} from "./sidebar.js";
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
  type SaveInput,
  type SearchResult,
  settingsSchema,
  idSchema,
  type LibrarySettings,
  type SecurityInfo,
  type DraftResult,
  type SearchInput,
  securityInfoSchema,
} from "../shared/schema.js";
import {
  api,
  client,
  ClientError,
  embedded,
  getEmbeddedState,
  subscribeEmbedded,
  connectEmbedded,
  requestEmbeddedFullscreen,
  readEmbeddedView,
  rememberEmbeddedView,
} from "./client.js";
import type { EmbeddedPresentation } from "./embedded.js";
import { useUnsavedChanges } from "./unsaved.js";
import { PortabilitySettings } from "./portability.js";
import { sharedCaptureSchema, type SharedCapture } from "../shared/capture.js";
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
const bytesLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function readSharedCapture(): SharedCapture | undefined {
  const element = document.getElementById("shared-drop");
  if (!(element instanceof HTMLTemplateElement)) return;
  try {
    const parsed = sharedCaptureSchema.safeParse(
      JSON.parse(element.content.textContent ?? ""),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}
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
      <span className="brand-name">
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
    chatgptEnabled?: boolean;
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
        chatgptEnabled={session.chatgptEnabled ?? false}
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
  chatgptEnabled,
  notice,
  onSuccess,
}: {
  setup: boolean;
  local: boolean;
  publicAccounts: boolean;
  signupEnabled: boolean;
  chatgptEnabled: boolean;
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
            {new URLSearchParams(location.search).get("chatgpt") ===
              "error" && (
              <Alert text="ChatGPT sign-in could not be completed. Sign in with your Drop It password and connect ChatGPT in Settings, or try again." />
            )}
            {chatgptEnabled && !creating && (
              <>
                <button
                  className="button"
                  disabled={busy}
                  onClick={async () => {
                    if (loginLock.current) return;
                    loginLock.current = true;
                    setBusy(true);
                    setError("");
                    try {
                      const authorize = new URLSearchParams(
                        location.search,
                      ).get("authorize");
                      const result = await api<{ url: string }>(
                        "/api/chatgpt/start",
                        "POST",
                        { ...(authorize ? { authorize } : {}) },
                      );
                      location.assign(result.url);
                    } catch (e) {
                      setError(message(e));
                      loginLock.current = false;
                      setBusy(false);
                    }
                  }}
                >
                  Continue with ChatGPT
                </button>
                <p className="muted">
                  First time? Sign in with your Drop It password, then connect
                  ChatGPT in Settings.
                </p>
              </>
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
                {publicAccounts && !signupEnabled && (
                  <p className="field-note">
                    Access is currently by invitation.{" "}
                    <a href="/support">Contact support to request access</a>.
                  </p>
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
  const [layout, setLayout] = useState(readLayout);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState(""),
    [view, setView] = useState<(typeof views)[number]>(() =>
      embedded ? (readEmbeddedView() ?? "All drops") : "All drops",
    ),
    [category, setCategory] = useState("");
  const [tag, setTag] = useState(""),
    [after, setAfter] = useState(""),
    [before, setBefore] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [searchMode, setSearchMode] = useState<
    "keyword" | "semantic" | "hybrid"
  >("hybrid");
  const [data, setData] = useState<SearchResult>({
    items: [],
    total: 0,
    counts: {},
    categories: [],
    aiAvailable: false,
    mode: "keyword",
  });
  const [loading, setLoading] = useState(!embedded),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(() => {
    if (embedded) return null;
    const parsed = idSchema.safeParse(
      new URLSearchParams(location.search).get("drop"),
    );
    return parsed.success ? parsed.data : null;
  });
  const [sharedCapture, setSharedCapture] = useState(readSharedCapture);
  useEffect(() => {
    document.getElementById("shared-drop")?.remove();
  }, []);
  const [adding, setAdding] = useState(Boolean(sharedCapture));
  const [hostDraft, setHostDraft] = useState<
    { source: NonNullable<SaveInput["source"]>; draft: DraftResult } | undefined
  >();
  const [hostDetail, setHostDetail] = useState<
    Awaited<ReturnType<typeof client.get>> | undefined
  >();
  const [hostState, setHostState] = useState(getEmbeddedState);
  const [pendingPresentation, setPendingPresentation] =
    useState<EmbeddedPresentation | null>(null);
  const applyPresentation = useRef<(value: EmbeddedPresentation) => void>(
    () => {},
  );
  const occupied = useRef(false);
  useLayoutEffect(() => {
    occupied.current = adding || Boolean(selected);
  }, [adding, selected]);
  const [pageSize, setPageSize] = useState(30);
  const [hasRequestedSearch, setHasRequestedSearch] = useState(!embedded);
  const [offset, setOffset] = useState(0),
    [tick, setTick] = useState(0),
    [settingsOpen, setSettingsOpen] = useState(
      new URLSearchParams(location.search).has("chatgpt"),
    );
  const [security, setSecurity] = useState<SecurityInfo | null>(null),
    [recoveryDeferred, setRecoveryDeferred] = useState(false);
  const [securityNotice, setSecurityNotice] = useState("");
  const refresh = useCallback(() => {
    setHasRequestedSearch(true);
    setTick((v) => v + 1);
  }, []);
  const loadSecurity = useCallback(() => {
    if (embedded) return;
    api<unknown>("/api/security")
      .then((value) => {
        setSecurity(securityInfoSchema.parse(value));
        setSecurityNotice("");
      })
      .catch(() =>
        setSecurityNotice(
          "Recovery status could not be checked. Open Settings to review your account security.",
        ),
      );
  }, []);
  useEffect(loadSecurity, [loadSecurity]);
  useEffect(() => {
    if (embedded && !hasRequestedSearch) return;
    let active = true;
    // Loading reflects an external request, not a value derived from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");
    const input: SearchInput = {
      query,
      mode: searchMode,
      view,
      category: category || undefined,
      tag: tag || undefined,
      after: after
        ? after.includes("T")
          ? after
          : new Date(`${after}T00:00:00`).toISOString()
        : undefined,
      before: before
        ? before.includes("T")
          ? before
          : new Date(`${before}T23:59:59.999`).toISOString()
        : undefined,
      offset,
      limit: pageSize,
    };
    client
      .search(input)
      .then((value) => {
        if (!active) return;
        const lastPage =
          Math.max(0, Math.ceil(value.total / pageSize) - 1) * pageSize;
        if (offset > lastPage) {
          setOffset(lastPage);
          return;
        }
        setData(value);
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    query,
    view,
    category,
    offset,
    tick,
    tag,
    after,
    before,
    searchMode,
    hasRequestedSearch,
    pageSize,
  ]);
  useEffect(() => {
    if (!embedded) return;
    let presentation: EmbeddedPresentation | null = null;
    applyPresentation.current = (presentation) => {
      setPendingPresentation(null);
      setHasRequestedSearch(false);
      setLoading(false);
      setError("");
      if (presentation.kind === "search") {
        const input = presentation.input;
        setQuery(input.query ?? "");
        setSearchDraft(input.query ?? "");
        setView(input.view ?? "All drops");
        setCategory(input.category ?? "");
        setTag(input.tag ?? "");
        setTagDraft(input.tag ?? "");
        setAfter(input.after ?? "");
        setBefore(input.before ?? "");
        setSearchMode(input.mode ?? "hybrid");
        setOffset(input.offset ?? 0);
        setPageSize(input.limit ?? 30);
        setData(presentation.result);
        setSelected(null);
        setAdding(false);
      } else if (presentation.kind === "detail") {
        setHostDetail(presentation.detail);
        setSelected(presentation.detail.item.id);
        setAdding(false);
      } else if (presentation.kind === "draft") {
        setSelected(null);
        setHostDraft({
          source: presentation.source,
          draft: presentation.draft,
        });
        setAdding(true);
      } else if (presentation.kind === "trashed") {
        setSelected(null);
      }
    };
    const receive = () => {
      const state = getEmbeddedState();
      setHostState(state);
      if (state.error) setLoading(false);
      if (!state.presentation || state.presentation === presentation) return;
      presentation = state.presentation;
      // A model result is never permission to discard or replace an open draft.
      if (occupied.current) setPendingPresentation(presentation);
      else applyPresentation.current(presentation);
    };
    const unsubscribe = subscribeEmbedded(receive);
    receive();
    void connectEmbedded().catch(() => receive());
    return unsubscribe;
  }, []);
  const changeView = (value: (typeof views)[number]) => {
    setView(value);
    setOffset(0);
    setHasRequestedSearch(true);
    if (embedded) rememberEmbeddedView(value);
  };
  const clearFilters = () => {
    setSearchDraft("");
    setQuery("");
    setCategory("");
    setTag("");
    setTagDraft("");
    setAfter("");
    setBefore("");
    changeView("All drops");
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
    <div className={`app ${embedded ? "embedded" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar" id="library-sidebar">
        <Brand />
        <span className="sidebar-label">LIBRARY</span>
        <nav aria-label="Library views">
          {views.map((value) => {
            const Icon = icons[value];
            return (
              <button
                key={value}
                className={`nav-item ${view === value ? "active" : ""}`}
                aria-label={`${value} ${data.counts[value] ?? 0}`}
                aria-current={view === value ? "page" : undefined}
                title={`${value} (${data.counts[value] ?? 0})`}
                onClick={() => changeView(value)}
              >
                <Icon
                  size={17}
                  className={value === "Trash" ? "trash-nav-icon" : undefined}
                />
                <span className="nav-label">{value}</span>
                <span className="nav-count">{data.counts[value] ?? 0}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          {!embedded && (
            <button className="nav-item" onClick={signOut} aria-label="Sign out" title="Sign out">
              <LogOut size={16} />
              <span className="nav-label">Sign out</span>
            </button>
          )}
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-leading">
            <SidebarToggle collapsed={sidebarCollapsed} onToggle={() => {
              const next = !sidebarCollapsed;
              setSidebarCollapsed(next);
              rememberSidebarCollapsed(next);
            }} />
            <span className="breadcrumb">
              Library <span>/</span> <strong>{view}</strong>
            </span>
          </div>
          <div className="top-actions">
            {embedded &&
              hostState.canFullscreen &&
              hostState.displayMode !== "fullscreen" && (
                <button
                  onClick={() =>
                    void requestEmbeddedFullscreen().catch((e) =>
                      setError(message(e)),
                    )
                  }
                >
                  Expand library
                </button>
              )}
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
              onClick={() => {
                setHostDraft(undefined);
                setSharedCapture(undefined);
                setAdding(true);
              }}
            >
              <Plus size={17} />
              <span className="new-drop-label">New drop</span>
            </button>
          </div>
        </header>
        <section className="library-content">
          {!embedded &&
            !recoveryDeferred &&
            security &&
            !security.recoveryEnabled && (
              <section
                className="onboarding-notice"
                aria-label="Protect your library"
              >
                <strong>Keep a way back into your library.</strong>
                <p>
                  You have no recovery code. There is no email reset; losing
                  your password could mean losing access to your drops.
                </p>
                <div className="actions">
                  <button onClick={() => setSettingsOpen(true)}>
                    Set up recovery in Settings
                  </button>
                  <button onClick={() => setRecoveryDeferred(true)}>
                    Remind me next sign-in
                  </button>
                </div>
              </section>
            )}
          {pendingPresentation && (
            <p className="onboarding-notice" role="status">
              A new ChatGPT result is ready. Close your current drop or draft
              before opening it.{" "}
              <button
                disabled={adding || Boolean(selected)}
                onClick={() => applyPresentation.current(pendingPresentation)}
              >
                Open latest ChatGPT result
              </button>
            </p>
          )}
          {securityNotice && (
            <p className="field-note" role="status">
              {securityNotice}
            </p>
          )}
          {embedded && !hostState.presentation && !hasRequestedSearch && (
            <p className="onboarding-notice">
              Ask ChatGPT to find or save a drop, or{" "}
              <button onClick={refresh}>Browse library</button>.
            </p>
          )}
          <div className="section-heading">
            <div>
              <h1>
                {view}
                <span className="heading-count">{data.total}</span>
              </h1>
            </div>
            <div className="heading-actions">
              <span className="saved-caption">Good things, kept.</span>
              <LayoutSwitcher value={layout} onChange={(value) => {
                setLayout(value);
                rememberLayout(value);
              }} />
            </div>
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
              setTag(tagDraft.trim());
              setOffset(0);
              refresh();
            }}
          >
            <label className="search">
              <Search size={18} />
              <input
                aria-label="Search your library"
                placeholder="What do you want to find?"
                title="Search your saved text. AI search is optional in Settings."
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
                    setHasRequestedSearch(true);
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
                  setHasRequestedSearch(true);
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
          <details className="search-options">
            <summary>Search options</summary>
            <div className="form-grid">
              <label>
                Tag
                <input
                  value={tagDraft}
                  maxLength={40}
                  placeholder="Any tag"
                  onChange={(e) => setTagDraft(e.target.value)}
                  onBlur={() => {
                    if (tagDraft.trim() === tag) return;
                    setTag(tagDraft.trim());
                    setOffset(0);
                    setHasRequestedSearch(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    setTag(tagDraft.trim());
                    setOffset(0);
                    setHasRequestedSearch(true);
                  }}
                />
              </label>
              <label>
                Search method
                <select
                  value={data.aiSearchEnabled ? searchMode : "keyword"}
                  onChange={(e) => {
                    setSearchMode(
                      e.target.value as "keyword" | "semantic" | "hybrid",
                    );
                    setOffset(0);
                    setHasRequestedSearch(true);
                  }}
                >
                  <option value="keyword">Keyword only</option>
                  <option value="hybrid" disabled={!data.aiSearchEnabled}>
                    Words and meaning (AI)
                  </option>
                  <option value="semantic" disabled={!data.aiSearchEnabled}>
                    Meaning only (AI)
                  </option>
                </select>
              </label>
              <label>
                Created from
                <input
                  type="date"
                  value={after.slice(0, 10)}
                  max={before.slice(0, 10) || undefined}
                  onChange={(e) => {
                    setAfter(e.target.value);
                    setOffset(0);
                    setHasRequestedSearch(true);
                  }}
                />
              </label>
              <label>
                Created through
                <input
                  type="date"
                  value={before.slice(0, 10)}
                  min={after.slice(0, 10) || undefined}
                  onChange={(e) => {
                    setBefore(e.target.value);
                    setOffset(0);
                    setHasRequestedSearch(true);
                  }}
                />
              </label>
            </div>
            <p className="field-note">
              Keyword search keeps queries within Drop It. Enable AI search in
              the website’s Settings to include related meanings.
            </p>
            <button type="button" onClick={clearFilters}>
              Clear filters
            </button>
          </details>
          <Alert text={embedded ? hostState.error || error : error} />
          {(error || (embedded && hostState.error)) && (
            <button
              onClick={() => {
                if (embedded && hostState.status === "error")
                  void connectEmbedded().catch(() => undefined);
                else refresh();
              }}
            >
              Retry
            </button>
          )}
          {loading ? (
            <div className="loading">
              <Busy />
            </div>
          ) : error ? null : data.items.length ? (
            <>
              {layout === "standard" && (
                <div className="list-labels">
                  <span>DROP</span>
                  <span>{view === "Trash" ? "DELETES" : "CREATED"}</span>
                  <span>{view === "Trash" ? "" : "SAVED"}</span>
                </div>
              )}
              <div className={`item-list layout-${layout}`}>
                {data.items.map((item) => (
                  <div key={item.id} className="item-row">
                    <button
                      className="item-open"
                      onClick={() => {
                        setHostDetail(undefined);
                        setSelected(item.id);
                      }}
                    >
                      {layout !== "compact" && (
                        <DropPreview
                          sourceId={item.sourceId}
                          hasImage={item.hasImage}
                          hasLink={Boolean(item.sourceUrl)}
                          enabled={!embedded}
                          size={layout === "icon" ? "grid" : "list"}
                        />
                      )}
                      <span className="item-copy">
                        <span className="item-title">{item.title}</span>
                        {layout === "standard" && (
                          <span className="item-summary">
                            {item.summary || item.notes || "No summary"}
                          </span>
                        )}
                        {layout === "standard" && query && item.matchType && (
                          <span className="match-evidence">
                            {item.matchType === "semantic"
                              ? "Related meaning"
                              : item.matchType === "both"
                                ? "Text and meaning match"
                                : "Text match"}
                            {item.matchSnippet ? ` · ${item.matchSnippet}` : ""}
                          </span>
                        )}
                        <span className="tags">
                          <span
                            className={`category-tag ${poolTone(item.category, data.categories)}`}
                            title={item.category}
                          >
                            {item.category}
                          </span>
                          {layout === "standard" &&
                            item.tags
                              .slice(0, 3)
                              .map((tag) => <span key={tag}>#{tag}</span>)}
                        </span>
                      </span>
                      {layout === "standard" && (
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
                      )}
                      {layout === "standard" && (
                        <ArrowUpRight className="row-arrow" size={16} />
                      )}
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
                  {offset + 1}-{Math.min(offset + pageSize, data.total)} of{" "}
                  {data.total}
                </span>
                <div className="actions">
                  <button
                    disabled={offset === 0}
                    onClick={() => {
                      setOffset((v) => Math.max(0, v - pageSize));
                      setHasRequestedSearch(true);
                    }}
                  >
                    Previous
                  </button>
                  <button
                    disabled={offset + pageSize >= data.total}
                    onClick={() => {
                      setOffset((v) => v + pageSize);
                      setHasRequestedSearch(true);
                    }}
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
                onClick={() => (total ? clearFilters() : setAdding(true))}
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
          {!embedded && (
            <nav aria-label="Library help">
              <a href="/about">About</a>
              <a href="/support">Support</a>
              <a href="/privacy">Privacy</a>
            </nav>
          )}
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
          initial={hostDraft}
          shared={sharedCapture}
          onOpenExisting={(id) => setSelected(id)}
          onClose={() => {
            setAdding(false);
            setHostDraft(undefined);
            setSharedCapture(undefined);
          }}
          onSaved={(item) => {
            setAdding(false);
            setHostDraft(undefined);
            setSharedCapture(undefined);
            setHostDetail(undefined);
            refresh();
            setSelected(item.id);
          }}
        />
      )}
      {selected && (
        <Detail
          categories={data.categories}
          key={selected}
          id={selected}
          initialDetail={
            hostDetail?.item.id === selected ? hostDetail : undefined
          }
          onClose={() => {
            setSelected(null);
            setHostDetail(undefined);
          }}
          onChange={refresh}
        />
      )}
      {settingsOpen && !embedded && (
        <SettingsPanel
          onClose={() => {
            setSettingsOpen(false);
            loadSecurity();
            refresh();
          }}
          onChanged={refresh}
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
  onPaste,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  onPaste?: React.ClipboardEventHandler<HTMLDialogElement>;
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
      onPaste={onPaste}
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
  onChanged,
}: {
  onClose: () => void;
  onSignedOut: (notice: string) => void;
  onChanged: () => void;
}) {
  const [settings, setSettings] = useState<LibrarySettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<
    "portability" | "disconnect" | "security" | null
  >(null);
  const [chatgptPassword, setChatgptPassword] = useState("");
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
  const setAISearch = async (enabled: boolean) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy("security");
    setError("");
    try {
      const result = await api<{ aiSearchEnabled: boolean }>(
        "/api/preferences",
        "PATCH",
        { aiSearchEnabled: enabled },
      );
      setSettings((value) => (value ? { ...value, ...result } : value));
      setNotice(
        enabled
          ? "AI search enabled. Saved text may be indexed with OpenAI when you search."
          : "Keyword-only search enabled. Search makes no OpenAI requests.",
      );
      onChanged();
    } catch (e) {
      setError(message(e));
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
        <PortabilitySettings
          disabled={busy !== null}
          onBusyChange={(active) => {
            actionLock.current = active;
            setBusy(active ? "portability" : null);
          }}
          onChange={() => {
            onChanged();
            setAttempt((value) => value + 1);
          }}
        />
        {settings?.storage && (
          <section
            className="settings-section"
            aria-labelledby="settings-storage"
          >
            <h3 id="settings-storage">Storage</h3>
            <p>
              {bytesLabel(settings.storage.attachmentBytes)} of{" "}
              {bytesLabel(settings.storage.attachmentLimitBytes)} attachments
              used.
            </p>
            <progress
              aria-label="Attachment storage used"
              value={settings.storage.attachmentBytes}
              max={settings.storage.attachmentLimitBytes}
            />
            <dl className="settings-facts">
              <div>
                <dt>Active originals</dt>
                <dd>{bytesLabel(settings.storage.activeBytes)}</dd>
              </div>
              <div>
                <dt>Trash originals</dt>
                <dd>{bytesLabel(settings.storage.trashBytes)}</dd>
              </div>
              <div>
                <dt>Unattached uploads</dt>
                <dd>{bytesLabel(settings.storage.abandonedBytes)}</dd>
              </div>
              <div>
                <dt>Awaiting expired cleanup</dt>
                <dd>{bytesLabel(settings.storage.expiredBytes)}</dd>
              </div>
              <div>
                <dt>Drops</dt>
                <dd>
                  {settings.storage.dropCount} / {settings.storage.dropLimit}
                </dd>
              </div>
              <div>
                <dt>Saved text</dt>
                <dd>
                  {bytesLabel(settings.storage.textBytes)} /{" "}
                  {bytesLabel(settings.storage.textLimitBytes)}
                </dd>
              </div>
            </dl>
            <p>
              Trash retains its originals for seven days. Unattached uploads
              expire after 24 hours; discarded captures release their
              unreferenced upload sooner. Shared originals are counted once.
            </p>
          </section>
        )}
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
            Disconnecting revokes connected apps’ access to your library. Your
            drops and this browser session stay intact. ChatGPT sign-in and plan
            usage are managed separately below.
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
        {(settings?.chatgpt?.enabled || settings?.chatgpt?.planRequired) && (
          <section
            className="settings-section chatgpt-settings"
            aria-labelledby="settings-chatgpt"
          >
            <h3 id="settings-chatgpt">ChatGPT account</h3>
            <p>
              {settings.chatgpt.connected
                ? "ChatGPT is connected for sign-in."
                : "Connect ChatGPT to this Drop It account for future sign-ins."}
            </p>
            <p>
              {settings.chatgpt.planRequired
                ? settings.chatgpt.planConnected
                  ? "AI drafts use your ChatGPT plan. Your plan limits apply; search uses keyword matching."
                  : "Connect your ChatGPT plan to use AI drafts. Manual entry and keyword search remain available."
                : "Connecting for sign-in does not enable ChatGPT plan usage."}
            </p>
            {new URLSearchParams(location.search).get("chatgpt") ===
              "error" && (
              <Alert text="ChatGPT could not be connected. Try again with the same ChatGPT account, or disconnect the existing link first." />
            )}
            {settings.chatgpt.enabled && (
              <>
                <label>
                  Current Drop It password
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={chatgptPassword}
                    maxLength={128}
                    disabled={busy !== null}
                    onChange={(e) => setChatgptPassword(e.target.value)}
                  />
                </label>
                <button
                  className="button"
                  disabled={busy !== null || !chatgptPassword}
                  onClick={async () => {
                    if (actionLock.current) return;
                    actionLock.current = true;
                    setBusy("security");
                    setError("");
                    try {
                      const result = await api<{ url: string }>(
                        "/api/chatgpt/start",
                        "POST",
                        {
                          link: true,
                          plan: settings.chatgpt?.planAvailable ?? false,
                          currentPassword: chatgptPassword,
                        },
                      );
                      setChatgptPassword("");
                      location.assign(result.url);
                    } catch (e) {
                      setError(message(e));
                      actionLock.current = false;
                      setBusy(null);
                    }
                  }}
                >
                  Continue with ChatGPT
                </button>
                {settings.chatgpt.planAvailable && (
                  <p>
                    You will be asked to allow Drop It to use your ChatGPT plan
                    for drafts. If access expires or you reach a limit, drafts
                    stop without using the site's API key.
                  </p>
                )}
                {settings.chatgpt.connected && (
                  <button
                    className="button secondary"
                    disabled={busy !== null || !chatgptPassword}
                    onClick={async () => {
                      if (actionLock.current) return;
                      actionLock.current = true;
                      setBusy("security");
                      setError("");
                      try {
                        const result = await api<{ revoked: boolean }>(
                          "/api/chatgpt/disconnect",
                          "POST",
                          { currentPassword: chatgptPassword },
                        );
                        setChatgptPassword("");
                        setAttempt((value) => value + 1);
                        onChanged();
                        setNotice(
                          result.revoked
                            ? "ChatGPT disconnected. Use your Drop It password to sign in."
                            : "Disconnected locally. Remote revocation could not be confirmed; also disconnect Drop It in ChatGPT Settings.",
                        );
                      } catch (e) {
                        setError(message(e));
                      } finally {
                        actionLock.current = false;
                        setBusy(null);
                      }
                    }}
                  >
                    Disconnect ChatGPT
                  </button>
                )}
              </>
            )}
            <a
              className="chatgpt-usage-link"
              href="https://chatgpt.com/settings/usage"
              target="_blank"
              rel="noreferrer"
            >
              Manage usage in ChatGPT
            </a>
          </section>
        )}
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
                  ? settings.chatgpt?.planRequired
                    ? settings.chatgpt.planConnected
                      ? "ChatGPT plan"
                      : "Connect ChatGPT plan"
                    : settings.aiConfigured
                      ? "Configured"
                      : "Not configured"
                  : "Unknown"}
              </dd>
            </div>
          </dl>
          <p>
            Drafting sends the selected source text, link and image or PDF
            content to OpenAI when you request a draft.
            {!settings?.chatgpt?.planRequired &&
              " Optional AI search sends your query and may index excerpts from all drops in the selected view and pool (up to 1,000), including unrelated notes and transcription. Unchanged indexed text is cached."}{" "}
            Keyword-only search makes no OpenAI requests.
          </p>
          <label className="preference-checkbox">
            <input
              type="checkbox"
              checked={
                !settings?.chatgpt?.planRequired &&
                (settings?.aiSearchEnabled ?? false)
              }
              disabled={
                busy !== null ||
                !settings?.aiConfigured ||
                settings?.chatgpt?.planRequired
              }
              onChange={(event) => void setAISearch(event.target.checked)}
            />
            Allow AI search for this account in the website and connected apps
          </label>
          <p>
            {settings?.chatgpt?.planRequired
              ? "ChatGPT authorization stays on the server. Your ChatGPT plan limits and applicable OpenAI data policies apply. Keyword search makes no AI requests."
              : "API keys stay on the server. Configuration does not confirm API access or available credit. OpenAI usage charges and the site's OpenAI project data policies apply."}
          </p>
        </section>
        <section className="settings-section" aria-labelledby="settings-help">
          <h3 id="settings-help">Capture and help</h3>
          <p>
            All drops contains everything outside Trash. Saved is a bookmark you
            can toggle with the ribbon. Links keep their address; Drop It does
            not fetch the webpage.
          </p>
          <p>
            Paste an image into New drop, or use the file picker. On browsers
            that support installed web apps, install Drop It to share text and
            links into an unsaved draft.
          </p>
          <button
            disabled={busy !== null}
            onClick={async () => {
              try {
                if (!("serviceWorker" in navigator))
                  throw new Error(
                    "This browser does not support installed web sharing. Use New drop instead.",
                  );
                await navigator.serviceWorker.register("/sw.js");
                setNotice(
                  "Sharing is ready. Use your browser’s Install app or Add to Home Screen command, then look for Drop It in its share menu. Availability depends on the browser.",
                );
              } catch (e) {
                setError(message(e));
              }
            }}
          >
            Prepare mobile sharing
          </button>
          <nav className="help-links" aria-label="Settings help">
            <a href="/support">Contact support</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </nav>
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
  initial,
  shared,
  onOpenExisting,
}: {
  onClose: () => void;
  onSaved: (item: Item) => void;
  categories: string[];
  aiAvailable: boolean;
  initial?: { source: NonNullable<SaveInput["source"]>; draft: DraftResult };
  shared?: SharedCapture;
  onOpenExisting: (id: string) => void;
}) {
  const [title, setTitle] = useState(
      initial?.draft.title ?? shared?.title ?? "",
    ),
    [summary, setSummary] = useState(initial?.draft.summary ?? ""),
    [text, setText] = useState(
      initial?.source.originalText ||
        initial?.draft.extractedText ||
        shared?.text ||
        "",
    ),
    [url, setUrl] = useState(
      initial?.source.url || initial?.draft.sourceUrl || shared?.url || "",
    ),
    [tags, setTags] = useState(initial?.draft.tags.join(", ") ?? ""),
    [category, setCategory] = useState(initial?.draft.category ?? ""),
    [notes, setNotes] = useState("");
  const [originalExtraction, setOriginalExtraction] = useState(
    initial?.source.originalText || initial?.draft.extractedText || "",
  );
  const [transcriptionEdited, setTranscriptionEdited] = useState(false);
  const [retainedAttachmentId, setRetainedAttachmentId] = useState(
    initial?.source.attachmentId,
  );
  const [duplicates, setDuplicates] = useState<{ id: string; title: string }[]>(
    [],
  );
  const actionLock = useRef(false);
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [duplicate, setDuplicate] = useState(false);
  const [drafted, setDrafted] = useState(Boolean(initial)),
    [drafting, setDrafting] = useState(false);
  const [manual, setManual] = useState(Boolean(initial || shared));
  const [storageRemaining, setStorageRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!embedded)
      api<LibrarySettings>("/api/settings")
        .then((value) => {
          if (value.storage)
            setStorageRemaining(
              value.storage.attachmentLimitBytes -
                value.storage.attachmentBytes,
            );
        })
        .catch(() => undefined);
  }, []);
  const upload = useRef<{
    file: File;
    id: string;
    originalText: string;
  } | null>(null);
  const attempt = useRef<{ signature: string; requestId: string } | null>(null);
  const { guard, confirmation } = useUnsavedChanges(
    Boolean(
      title ||
      summary ||
      text ||
      url ||
      tags ||
      category ||
      notes ||
      file ||
      initial,
    ),
  );
  const releaseUpload = async () => {
    const uploaded = upload.current;
    upload.current = null;
    if (!uploaded || embedded) return;
    try {
      await api(`/api/attachments/${uploaded.id}`, "DELETE");
    } catch {
      /* Abandoned uploads remain bounded and expire automatically. */
    }
  };
  const closeCapture = () => {
    if (actionLock.current) return;
    guard(() => {
      void releaseUpload();
      onClose();
    });
  };
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const pick = (next: File | undefined) => {
    if (actionLock.current) return;
    if (!next) return;
    if (!fileMime(next.name) || !next.size || next.size > maxFileBytes) {
      setError(
        "Choose an image, PDF, TXT, Markdown, CSV, or JSON file under 10 MB.",
      );
      return;
    }
    if (storageRemaining !== null && next.size > storageRemaining) {
      setError(
        "This file exceeds your remaining attachment storage. Review usage and Trash retention in Settings.",
      );
      return;
    }
    const replaceSource = () => {
      void releaseUpload();
      setRetainedAttachmentId(undefined);
      setOriginalExtraction("");
      setTranscriptionEdited(false);
      setText("");
      if (file || retainedAttachmentId) setUrl("");
      setFile(next);
      setPreview(
        isImageMime(fileMime(next.name) ?? "") ? URL.createObjectURL(next) : "",
      );
      setError("");
      setDuplicate(false);
      setDuplicates([]);
      if (!manual) {
        setDrafted(false);
        setTitle("");
        setSummary("");
        setCategory("");
        setTags("");
        setUrl("");
        if (aiAvailable) void draft(next);
      }
    };
    if (transcriptionEdited) guard(replaceSource);
    else replaceSource();
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
      originalText: selected
        ? upload.current?.originalText ||
          (selected === file ? originalExtraction : "")
        : retainedAttachmentId
          ? originalExtraction
          : fileOnly
            ? ""
            : text,
      url: fileOnly ? "" : url,
      attachmentId: selected ? upload.current?.id : retainedAttachmentId,
    };
  };
  const draft = async (sourceFile?: File) => {
    if (actionLock.current) return;
    actionLock.current = true;
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
      if (sourceFile || !text.trim()) {
        const extraction =
          (selected ? upload.current?.originalText : "") || draft.extractedText;
        setText(extraction);
        setTranscriptionEdited(false);
        if (selected || retainedAttachmentId) setOriginalExtraction(extraction);
      }
      if (sourceFile || !url.trim()) setUrl(draft.sourceUrl);
      setDrafted(true);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
      setDrafting(false);
      actionLock.current = false;
    }
  };
  const save = async (allowDuplicate = false) => {
    if (actionLock.current) return;
    actionLock.current = true;
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
        ...(source.attachmentId &&
        transcriptionEdited &&
        text !== source.originalText
          ? { reviewedTranscription: text }
          : {}),
        allowDuplicate,
      };
      const signature = JSON.stringify(fields);
      if (attempt.current?.signature !== signature)
        attempt.current = { signature, requestId: crypto.randomUUID() };
      const result = await client.save({
        ...fields,
        requestId: attempt.current.requestId,
      } satisfies SaveInput);
      upload.current = null;
      onSaved(result.item);
    } catch (e) {
      setError(message(e));
      setDuplicate(e instanceof ClientError && e.code === "DUPLICATE");
      setDuplicates(e instanceof ClientError ? (e.details?.items ?? []) : []);
    } finally {
      setBusy(false);
      actionLock.current = false;
    }
  };
  return (
    <Panel
      title="New drop"
      onClose={closeCapture}
      onPaste={(event) => {
        const pasted = [...event.clipboardData.items]
          .find(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          )
          ?.getAsFile();
        if (pasted) {
          event.preventDefault();
          pick(pasted);
        }
      }}
    >
      {confirmation}
      <form
        className="panel-body capture"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual || drafted) void save();
        }}
      >
        <fieldset disabled={busy} className="capture-fields">
          {shared && (
            <p className="settings-notice" role="status">
              Shared text or link · Review this unsaved draft before creating a
              drop.
            </p>
          )}
          <div className="capture-options">
            <button type="button" onClick={() => setManual(true)}>
              Text or link
            </button>
            <span className="field-note">
              Choose a file below, or paste an image.
            </span>
          </div>
          {storageRemaining !== null && (
            <p className="field-note">
              {bytesLabel(Math.max(0, storageRemaining))} attachment space
              remaining.
            </p>
          )}
          <label
            className={`upload-area ${file || retainedAttachmentId ? "has-file" : ""}`}
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
                <span>
                  {file
                    ? file.name
                    : retainedAttachmentId
                      ? "Original attached from ChatGPT"
                      : "Drop a file"}
                </span>
                <span className="field-note">
                  Images, PDF, TXT, Markdown, CSV, JSON · Up to 10 MB
                </span>
              </>
            )}
            <input
              type="file"
              accept={fileAccept}
              aria-label="Drop a file"
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {(file || retainedAttachmentId) && (
            <div className="file-label">
              <span>{file?.name ?? "Original attached from ChatGPT"}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Remove file"
                onClick={() => {
                  if (actionLock.current) return;
                  const removeSource = () => {
                    setFile(null);
                    setRetainedAttachmentId(undefined);
                    setPreview("");
                    void releaseUpload();
                    setOriginalExtraction("");
                    setText("");
                    setTranscriptionEdited(false);
                    setDuplicate(false);
                    setDuplicates([]);
                    if (!manual) {
                      setDrafted(false);
                      setTitle("");
                      setSummary("");
                      setCategory("");
                      setTags("");
                      setUrl("");
                    }
                  };
                  if (transcriptionEdited) guard(removeSource);
                  else removeSource();
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
                  <label>
                    Review transcription
                    <textarea
                      value={text}
                      onChange={(event) => {
                        setText(event.target.value);
                        setTranscriptionEdited(true);
                      }}
                      maxLength={50000}
                      rows={5}
                    />
                  </label>
                  <p className="field-note">
                    Extraction may be incomplete or inaccurate. Review it for
                    search; the original file is preserved separately.
                  </p>
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
                  onChange={(e) => {
                    setText(e.target.value);
                    setTranscriptionEdited(true);
                  }}
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
                    !aiAvailable ||
                    (!text.trim() &&
                      !url.trim() &&
                      !file &&
                      !retainedAttachmentId)
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
          {duplicate &&
            duplicates.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => onOpenExisting(item.id)}
              >
                Open existing: {item.title}
              </button>
            ))}
          {duplicate && (
            <p className="field-note">
              Your draft remains open. If the existing drop is in Trash, open it
              to restore it.
            </p>
          )}
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
            <button type="button" disabled={busy} onClick={closeCapture}>
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
  initialDetail,
}: {
  id: string;
  onClose: () => void;
  onChange: () => void;
  categories: string[];
  initialDetail?: Awaited<ReturnType<typeof client.get>>;
}) {
  const [detail, setDetail] = useState<Awaited<
    ReturnType<typeof client.get>
  > | null>(initialDetail ?? null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [showTranscription, setShowTranscription] = useState(false),
    [downloadNotice, setDownloadNotice] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false),
    [conflict, setConflict] = useState(false),
    [conflictReloaded, setConflictReloaded] = useState(false);
  const [notes, setNotes] = useState(initialDetail?.item.notes ?? ""),
    [title, setTitle] = useState(initialDetail?.item.title ?? ""),
    [summary, setSummary] = useState(initialDetail?.item.summary ?? ""),
    [tags, setTags] = useState(initialDetail?.item.tags.join(", ") ?? ""),
    [category, setCategory] = useState(initialDetail?.item.category ?? ""),
    [reviewedText, setReviewedText] = useState(
      initialDetail?.item.reviewedTranscription ??
        initialDetail?.source.originalText ??
        "",
    );
  const metadataDirty = Boolean(
    detail &&
    (title !== detail.item.title ||
      summary !== detail.item.summary ||
      tags !== detail.item.tags.join(", ") ||
      category !== detail.item.category),
  );
  const dirty = Boolean(
    detail &&
    (metadataDirty ||
      notes !== detail.item.notes ||
      reviewedText !==
        (detail.item.reviewedTranscription ?? detail.source.originalText)),
  );
  const { guard, confirmation } = useUnsavedChanges(dirty);
  const actionLock = useRef(false);
  const transcriptionId = useId();
  const wipeConfirmation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmDelete) {
      wipeConfirmation.current?.scrollIntoView({ block: "nearest" });
      wipeConfirmation.current?.querySelector("button")?.focus();
    }
  }, [confirmDelete]);
  const applyDetail = useCallback(
    (result: Awaited<ReturnType<typeof client.get>>) => {
      setDetail(result);
      setNotes(result.item.notes);
      setTitle(result.item.title);
      setSummary(result.item.summary);
      setTags(result.item.tags.join(", "));
      setCategory(result.item.category);
      setReviewedText(
        result.item.reviewedTranscription ?? result.source.originalText,
      );
    },
    [],
  );
  const load = async (preserve = false) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setDownloadNotice("");
    try {
      const result = await client.get(id);
      applyDetail(result);
      // Preserve only fields edited against the previous revision. Keeping every
      // stale field would turn someone else's changes into apparent local edits.
      if (preserve && detail) {
        if (notes !== detail.item.notes) setNotes(notes);
        if (title !== detail.item.title) setTitle(title);
        if (summary !== detail.item.summary) setSummary(summary);
        if (tags !== detail.item.tags.join(", ")) setTags(tags);
        if (category !== detail.item.category) setCategory(category);
        if (
          reviewedText !==
          (detail.item.reviewedTranscription ?? detail.source.originalText)
        )
          setReviewedText(reviewedText);
        setConflictReloaded(conflict);
        setDownloadNotice(
          "Latest saved version loaded. Your edited fields are retained; compare them before saving again.",
        );
      } else {
        setConflict(false);
        setConflictReloaded(false);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      actionLock.current = false;
    }
  };
  useEffect(() => {
    if (initialDetail) return;
    let active = true;
    client
      .get(id)
      .then((result) => {
        if (active) applyDetail(result);
      })
      .catch((error) => {
        if (active) setError(message(error));
      });
    return () => {
      active = false;
    };
  }, [id, initialDetail, applyDetail]);
  const update = async (
    fields: Record<string, unknown>,
    finishEditing = false,
  ) => {
    if (!detail || actionLock.current) return;
    actionLock.current = true;
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
        downloadPageUrl: detail.downloadPageUrl,
      });
      if (finishEditing) {
        setEditing(false);
        setTitle(result.item.title);
        setSummary(result.item.summary);
        setCategory(result.item.category);
        setTags(result.item.tags.join(", "));
      }
      if ("notes" in fields) setNotes(result.item.notes);
      if ("reviewedTranscription" in fields)
        setReviewedText(
          result.item.reviewedTranscription ?? result.source.originalText,
        );
      setConflict(false);
      setConflictReloaded(false);
      onChange();
    } catch (e) {
      setError(message(e));
      setConflict(e instanceof ClientError && e.code === "CONFLICT");
      setConflictReloaded(false);
    } finally {
      setBusy(false);
      actionLock.current = false;
    }
  };
  return (
    <Panel
      title="Drop"
      onClose={() => {
        if (!actionLock.current) guard(onClose);
      }}
    >
      {confirmation}
      <div className="panel-body">
        <fieldset disabled={busy} className="capture-fields">
          <Alert text={error} />
          {downloadNotice && <p role="status">{downloadNotice}</p>}
          {(error || conflict) && (
            <div className="actions">
              <button disabled={busy} onClick={() => void load(true)}>
                Load latest, keep my edits
              </button>
              <button disabled={busy} onClick={() => guard(() => void load())}>
                Reload and discard edits
              </button>
            </div>
          )}
          {conflict && detail && (
            <details className="conflict-review" open>
              <summary>
                {conflictReloaded
                  ? "Compare with the latest saved version"
                  : "Last loaded version — load latest to compare"}
              </summary>
              <p>Title: {detail.item.title}</p>
              <p>Summary: {detail.item.summary || "None"}</p>
              <p>Pool: {detail.item.category}</p>
              <p>Tags: {detail.item.tags.join(", ") || "None"}</p>
              <p>Notes:</p>
              <pre>{detail.item.notes || "None"}</pre>
              <p>Reviewed transcription:</p>
              <pre>
                {detail.item.reviewedTranscription ??
                  detail.source.originalText}
              </pre>
              <p>
                Your edited fields stay below.{" "}
                {conflictReloaded
                  ? "Review the differences before reapplying them."
                  : "This version may be out of date."}
              </p>
            </details>
          )}
          {!detail ? (
            !error && <Busy />
          ) : (
            <>
              <div className="detail-meta">
                <span
                  className={`category-tag ${poolTone(detail.item.category, categories)}`}
                >
                  {detail.item.category}
                </span>
                <span>Created {date(detail.item.createdAt)}</span>
                {!detail.item.trashedAt && (
                  <SaveRibbon
                    saved={detail.item.isSaved}
                    disabled={busy}
                    onClick={() =>
                      void update({ isSaved: !detail.item.isSaved })
                    }
                  />
                )}
                <button
                  className="icon-button"
                  aria-label="Edit item"
                  title="Edit item"
                  disabled={busy || Boolean(detail.item.trashedAt)}
                  onClick={() => {
                    if (editing && metadataDirty)
                      guard(() => {
                        if (detail) {
                          setTitle(detail.item.title);
                          setSummary(detail.item.summary);
                          setTags(detail.item.tags.join(", "));
                          setCategory(detail.item.category);
                        }
                        setEditing(false);
                      });
                    else setEditing((v) => !v);
                  }}
                >
                  <Pencil size={16} />
                </button>
              </div>
              {editing ? (
                <form
                  className="edit-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void update(
                      {
                        title,
                        summary,
                        tags: tags
                          .split(",")
                          .map((v) => v.trim())
                          .filter(Boolean),
                        category: category.trim() || "Uncategorized",
                      },
                      true,
                    );
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
                {embedded &&
                  detail.source.hasFile &&
                  !detail.fileData &&
                  !detail.imageData && (
                    <button disabled={busy} onClick={() => void load(true)}>
                      Load original file
                    </button>
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
                        if (actionLock.current) return;
                        actionLock.current = true;
                        setBusy(true);
                        setError("");
                        setDownloadNotice("");
                        try {
                          const result = await client.download(id);
                          if (result === "browser")
                            setDownloadNotice(
                              "Download the original from the Drop It page opened in your browser. Sign in there if prompted.",
                            );
                        } catch (error) {
                          setError(message(error));
                        } finally {
                          setBusy(false);
                          actionLock.current = false;
                        }
                      }}
                    >
                      <ArrowDownToLine size={15} />
                      <span>
                        {detail.source.filename ?? "Download original"}
                      </span>
                    </button>
                  ) : (
                    <a
                      className="source-link"
                      href={`/api/sources/${detail.source.id}/file`}
                      download={detail.source.filename ?? "source"}
                    >
                      <ArrowDownToLine size={15} />
                      <span>
                        {detail.source.filename ?? "Download original"}
                      </span>
                    </a>
                  ))}
                {!detail.source.url &&
                  !detail.source.hasFile &&
                  !detail.source.originalText && (
                    <p className="muted">No source attached.</p>
                  )}
              </div>
              {(detail.source.hasFile || detail.source.originalText) && (
                <section
                  className="detail-section"
                  aria-labelledby="reviewed-transcription-heading"
                >
                  <h3 id="reviewed-transcription-heading">
                    Reviewed transcription
                  </h3>
                  <p className="field-note">
                    Correct text used for retrieval without changing the
                    original source or file.{" "}
                    {detail.item.transcriptionUpdatedAt
                      ? `Reviewed ${date(detail.item.transcriptionUpdatedAt)}.`
                      : "No corrections saved."}
                  </p>
                  <textarea
                    aria-label="Reviewed transcription"
                    rows={5}
                    value={reviewedText}
                    maxLength={50000}
                    readOnly={Boolean(detail.item.trashedAt)}
                    onChange={(event) => setReviewedText(event.target.value)}
                  />
                  <div className="actions">
                    <button
                      disabled={
                        busy ||
                        Boolean(detail.item.trashedAt) ||
                        reviewedText ===
                          (detail.item.reviewedTranscription ??
                            detail.source.originalText)
                      }
                      onClick={() =>
                        void update({ reviewedTranscription: reviewedText })
                      }
                    >
                      Save transcription
                    </button>
                    {detail.item.reviewedTranscription !== null &&
                      detail.item.reviewedTranscription !== undefined && (
                        <button
                          disabled={busy || Boolean(detail.item.trashedAt)}
                          onClick={() =>
                            guard(
                              () =>
                                void update({ reviewedTranscription: null }),
                            )
                          }
                        >
                          Use original transcription
                        </button>
                      )}
                  </div>
                </section>
              )}
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
                      if (actionLock.current) return;
                      actionLock.current = true;
                      setBusy(true);
                      setError("");
                      try {
                        await client.restore(id, detail.item.revision);
                        onChange();
                        onClose();
                      } catch (e) {
                        setError(message(e));
                        setConflict(
                          e instanceof ClientError && e.code === "CONFLICT",
                        );
                        setConflictReloaded(false);
                      } finally {
                        setBusy(false);
                        actionLock.current = false;
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
                      before it is permanently deleted. Unsaved edits will be
                      discarded.
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
                          if (actionLock.current) return;
                          actionLock.current = true;
                          setBusy(true);
                          setError("");
                          try {
                            await client.delete(id, detail.item.revision);
                            onChange();
                            onClose();
                          } catch (e) {
                            setError(message(e));
                            setConflict(
                              e instanceof ClientError && e.code === "CONFLICT",
                            );
                            setConflictReloaded(false);
                          } finally {
                            setBusy(false);
                            actionLock.current = false;
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
        </fieldset>
      </div>
    </Panel>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
