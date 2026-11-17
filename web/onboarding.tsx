import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Plus, Search, PlugZap, X } from "lucide-react";
import { onboardingSchema, type Onboarding } from "../shared/onboarding.js";
import { api, embedded } from "./client.js";

type Action = "dismiss" | "reopen" | "use-website" | "choose-connection";

export function useOnboarding(refresh: number) {
  const [state, setState] = useState<Onboarding | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (embedded) return;
    let active = true;
    const current = ++generation.current;
    api<unknown>("/api/onboarding")
      .then((value) => {
        if (active && current === generation.current) {
          setState(onboardingSchema.parse(value));
          setError("");
        }
      })
      .catch(() => {
        if (active && current === generation.current)
          setError(
            "Getting started could not be loaded. Your library is still available.",
          );
      });
    return () => {
      active = false;
    };
  }, [refresh, version]);
  useEffect(() => {
    if (embedded) return;
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  const act = async (action: Action) => {
    if (locked.current) return;
    locked.current = true;
    ++generation.current;
    setBusy(true);
    setError("");
    try {
      setState(
        onboardingSchema.parse(
          await api("/api/onboarding", "PATCH", { action }),
        ),
      );
    } catch {
      setError("Setup progress could not be saved. Please try again.");
      throw new Error("Setup progress could not be saved.");
    } finally {
      locked.current = false;
      setBusy(false);
      // Reconcile with a focus refresh that may have overlapped this write.
      reload();
    }
  };
  return { state, error, busy, reload, act };
}

export function GettingStarted({
  guide,
  onSave,
  onFind,
}: {
  guide: ReturnType<typeof useOnboarding>;
  onSave: () => void;
  onFind: (title: string) => void;
}) {
  const [connectionHelp, setConnectionHelp] = useState(false);
  const [checkNotice, setCheckNotice] = useState(false);
  const { state, error, busy, reload, act } = guide;
  if (!state || state.dismissed)
    return error ? (
      <p className="onboarding-notice" role="status">
        {error} <button onClick={reload}>Retry getting started</button>
      </p>
    ) : null;
  const connected = state.connections.extension || state.connections.chatgpt;
  const complete = [
    Boolean(state.firstDrop),
    connected || state.websiteOnly,
    state.found,
  ];
  const count = complete.filter(Boolean).length;
  const perform = (action: Action) => void act(action).catch(() => undefined);
  return (
    <section
      className="getting-started"
      aria-labelledby="getting-started-title"
    >
      <div className="getting-started-heading">
        <div>
          <span className="eyebrow">MAKE YOURSELF AT HOME</span>
          <h2 id="getting-started-title">
            {count === 3
              ? "You’re ready to drop it."
              : "A good idea deserves a place to land."}
          </h2>
          <p>
            {count === 3
              ? "Keep capturing. Your library will be here when you need it."
              : "Save something useful, choose how to capture, then pick it up again."}
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Dismiss getting started"
          disabled={busy}
          onClick={() => perform("dismiss")}
        >
          <X size={18} />
        </button>
      </div>
      <p className="setup-progress" role="status">
        {count} of 3 steps complete
        {state.websiteOnly && !connected ? " · Using the website" : ""}
      </p>
      <ol className="setup-steps">
        <li>
          <span className={`setup-number ${complete[0] ? "is-complete" : ""}`}>
            {complete[0] ? <Check size={17} aria-label="Complete" /> : "1"}
          </span>
          <h3>Save your first drop</h3>
          <p>
            A link, a note, or a file. Start with something you want to come
            back to.
          </p>
          {state.firstDrop ? (
            <p className="setup-done">
              Saved: <span>{state.firstDrop.title}</span>
            </p>
          ) : (
            <button className="primary" onClick={onSave}>
              <Plus size={16} />
              Save a drop
            </button>
          )}
        </li>
        <li>
          <span className={`setup-number ${complete[1] ? "is-complete" : ""}`}>
            {complete[1] ? <Check size={17} aria-label="Complete" /> : "2"}
          </span>
          <h3>Capture where you are</h3>
          <p>
            Connect the Chrome extension or ChatGPT to save without switching
            back here.
          </p>
          {connected ? (
            <p className="setup-done">
              {state.connections.extension && state.connections.chatgpt
                ? "Extension and ChatGPT connected"
                : state.connections.extension
                  ? "Extension connected"
                  : "ChatGPT connected"}
            </p>
          ) : (
            <button
              disabled={busy}
              onClick={() => {
                if (state.websiteOnly && !connectionHelp)
                  perform("choose-connection");
                setConnectionHelp(!connectionHelp);
                setCheckNotice(false);
              }}
              aria-expanded={connectionHelp}
              aria-controls="setup-connections"
            >
              <PlugZap size={16} />
              {state.websiteOnly ? "Add a connection" : "Choose a connection"}
            </button>
          )}
          {!connected && !state.websiteOnly && (
            <button
              className="setup-later"
              disabled={busy}
              onClick={() => {
                perform("use-website");
                setConnectionHelp(false);
              }}
            >
              Use the website for now
            </button>
          )}
          {state.websiteOnly && !connected && (
            <p className="field-note">
              Website selected. You can connect an app later.
            </p>
          )}
        </li>
        <li>
          <span className={`setup-number ${complete[2] ? "is-complete" : ""}`}>
            {complete[2] ? <Check size={17} aria-label="Complete" /> : "3"}
          </span>
          <h3>Find it again</h3>
          <p>
            Search a few words you remember. Results appear below, ready to
            open.
          </p>
          {state.found ? (
            <p className="setup-done">You found a saved drop</p>
          ) : (
            <button
              disabled={!state.firstDrop}
              onClick={() => state.firstDrop && onFind(state.firstDrop.title)}
            >
              <Search size={16} />
              Find my drop
            </button>
          )}
          {!state.firstDrop && (
            <p className="field-note">Save a drop to try this.</p>
          )}
        </li>
      </ol>
      {connectionHelp && !connected && (
        <div className="setup-connections" id="setup-connections">
          <div>
            <h3>
              Chrome extension{" "}
              <span className="field-note">Desktop Chrome</span>
            </h3>
            {state.extensionAvailable ? (
              <>
                <p>
                  Download and unzip the extension. In Chrome’s Extensions page,
                  turn on Developer mode, choose Load unpacked, and select the
                  unzipped folder. Pin Drop It, open it, then choose Connect and
                  approve this account.
                </p>
                <a
                  href="/api/onboarding/extension"
                  download="drop-it-chrome.zip"
                >
                  Download Chrome extension
                </a>
                <p className="field-note">
                  This is a manual installation. Capture uses the page or
                  selection you choose; review the access request before
                  connecting.
                </p>
              </>
            ) : (
              <p>
                The extension download isn’t available on this host.{" "}
                <a href="/support" target="_blank" rel="noreferrer">
                  Contact support
                </a>{" "}
                for installation help, or use ChatGPT or the website.
              </p>
            )}
          </div>
          <div>
            <h3>ChatGPT</h3>
            {state.chatgptAvailable ? (
              <>
                <p>
                  In ChatGPT, open Settings → Plugins (or Apps), find Drop It,
                  and select Connect. Sign in to this Drop It account and
                  approve library access. If Drop It is unavailable for your
                  account or workspace, use the website for now.
                </p>
                <a href="https://chatgpt.com/" target="_blank" rel="noreferrer">
                  Open ChatGPT <span aria-hidden="true">↗</span>
                </a>
                <p className="field-note">
                  Then ask: “Use Drop It to find something I saved.”{" "}
                  <a
                    href="https://help.openai.com/en/articles/20001494-connecting-and-managing-app-accounts-in-chatgpt"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Connection help
                  </a>
                </p>
              </>
            ) : (
              <p>
                ChatGPT library connections aren’t configured on this host. You
                can still save and search here.
              </p>
            )}
            <p className="field-note">
              Connecting shares requested library content with ChatGPT. Manage
              access in Settings.
            </p>
          </div>
          <div className="setup-check">
            <button
              disabled={busy}
              onClick={() => {
                reload();
                setCheckNotice(true);
              }}
            >
              Check connection
            </button>
            {checkNotice && (
              <p role="status">
                Once authorization is complete for this account, this step will
                update. If it stays incomplete, check the account you connected
                or continue with the website.
              </p>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert">
          {error} <button onClick={reload}>Retry getting started</button>
        </p>
      )}
      {count === 3 && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => perform("dismiss")}
        >
          Finish setup
        </button>
      )}
      <p className="setup-footnote">
        Pick this up anytime in Settings → Getting started.
      </p>
    </section>
  );
}
