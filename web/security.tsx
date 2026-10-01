import { useEffect, useRef, useState } from "react";
import {
  KeyRound,
  LoaderCircle,
  LogOut,
  Monitor,
  ShieldCheck,
} from "lucide-react";
import {
  recoveryCodeSchema,
  securityInfoSchema,
  type SecurityInfo,
} from "../shared/schema.js";
import { api } from "./client.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "The action could not be completed.";
const timestamp = (value: string) => new Date(value).toLocaleString();
async function confirmedAction(path: string, body: Record<string, string>) {
  const result = await api<{ ok?: unknown } | null>(path, "POST", body);
  if (result?.ok !== true)
    throw new Error(
      "The action could not be confirmed. Reload to check your sign-in status.",
    );
}

function ErrorMessage({ text }: { text: string }) {
  return text ? (
    <div className="error" role="alert">
      {text}
    </div>
  ) : null;
}

export function NewPasswordFields({
  password,
  confirmation,
  onPassword,
  onConfirmation,
}: {
  password: string;
  confirmation: string;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
}) {
  return (
    <>
      <label>
        New password
        <input
          type="password"
          name="newPassword"
          autoComplete="new-password"
          minLength={15}
          maxLength={128}
          required
          value={password}
          onChange={(event) => onPassword(event.target.value)}
        />
        <span className="field-note">
          Use at least 15 characters. A unique passphrase works well.
        </span>
      </label>
      <label>
        Confirm new password
        <input
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          minLength={15}
          maxLength={128}
          required
          value={confirmation}
          onChange={(event) => onConfirmation(event.target.value)}
        />
      </label>
    </>
  );
}

export function RecoveryForm({
  onCancel,
  onRecovered,
}: {
  onCancel: () => void;
  onRecovered: () => void;
}) {
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  return (
    <>
      <span className="eyebrow">ACCOUNT RECOVERY</span>
      <h1>Find your way back.</h1>
      <p className="muted">
        Use the recovery code you saved in Settings. It works once. Resetting
        your password signs out every browser and disconnects all apps.
      </p>
      <p className="field-note">
        There is no email reset. You need a previously saved recovery code.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current) return;
          const parsedCode = recoveryCodeSchema.safeParse(recoveryCode);
          if (!parsedCode.success) {
            setError("Enter the complete recovery code you saved.");
            return;
          }
          if (newPassword !== confirmation) {
            setError("The new passwords do not match.");
            return;
          }
          lock.current = true;
          setBusy(true);
          setError("");
          try {
            await confirmedAction("/api/recover", {
              recoveryCode: parsedCode.data,
              newPassword,
            });
            onRecovered();
          } catch (error) {
            setError(message(error));
          } finally {
            setRecoveryCode("");
            setNewPassword("");
            setConfirmation("");
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="security-fields">
          <label>
            Recovery code
            <input
              type="password"
              name="recoveryCode"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              minLength={43}
              maxLength={100}
              required
              autoFocus
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
            />
          </label>
          <NewPasswordFields
            password={newPassword}
            confirmation={confirmation}
            onPassword={setNewPassword}
            onConfirmation={setConfirmation}
          />
          <ErrorMessage text={error} />
          <button className="primary full" type="submit">
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <KeyRound size={17} />
            )}
            Reset password
          </button>
          <button type="button" onClick={onCancel}>
            Back to sign in
          </button>
        </fieldset>
      </form>
    </>
  );
}

type SecurityAction =
  | { kind: "password" }
  | { kind: "recovery" }
  | { kind: "logout-all" }
  | { kind: "session"; session: SecurityInfo["sessions"][number] };

const actionTitle = (action: SecurityAction) => {
  if (action.kind === "password") return "Change password";
  if (action.kind === "recovery") return "Generate recovery code";
  if (action.kind === "logout-all") return "Sign out everywhere";
  return action.session.current
    ? "Sign out this browser"
    : "Revoke browser session";
};

function SecurityActionForm({
  action,
  disabled,
  onCancel,
  onSubmit,
}: {
  action: SecurityAction;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const explanations = {
    password:
      "This signs out every browser, disconnects all apps, and invalidates your recovery code. Sign in with the new password, then generate a new recovery code.",
    recovery:
      "Save the new code somewhere safe outside Drop It. It replaces any existing code and lets you reset your password once. Anyone with the code can access your account.",
    "logout-all":
      "This signs out this browser and all other browsers and disconnects every app. Your password and saved drops stay the same.",
    session:
      action.kind === "session" && action.session.current
        ? "This signs out the browser you are using. Other browser sessions and connected apps remain signed in."
        : "This signs out the selected browser session. Other browser sessions and connected apps remain signed in.",
  };
  return (
    <form
      className="security-action"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || lock.current) return;
        if (action.kind === "password" && newPassword !== confirmation) {
          setError("The new passwords do not match.");
          return;
        }
        lock.current = true;
        setError("");
        try {
          await onSubmit(currentPassword, newPassword);
        } catch (error) {
          setError(message(error));
        } finally {
          setCurrentPassword("");
          setNewPassword("");
          setConfirmation("");
          lock.current = false;
        }
      }}
    >
      <h4>{actionTitle(action)}</h4>
      <p>{explanations[action.kind]}</p>
      {action.kind === "session" && (
        <p>
          <strong>{action.session.label}</strong> · Signed in{" "}
          {timestamp(action.session.createdAt)}
        </p>
      )}
      <fieldset disabled={disabled} className="security-fields">
        <label>
          Current password
          <input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            minLength={1}
            maxLength={128}
            required
            autoFocus
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        {action.kind === "password" && (
          <NewPasswordFields
            password={newPassword}
            confirmation={confirmation}
            onPassword={setNewPassword}
            onConfirmation={setConfirmation}
          />
        )}
        <ErrorMessage text={error} />
        <div className="actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className={action.kind === "recovery" ? "primary" : "danger"}
          >
            {disabled && <LoaderCircle className="spin" size={17} />}
            {actionTitle(action)}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export function SecuritySettings({
  disabled,
  beginAction,
  endAction,
  onSignedOut,
}: {
  disabled: boolean;
  beginAction: () => boolean;
  endAction: () => void;
  onSignedOut: (notice: string) => void;
}) {
  const [info, setInfo] = useState<SecurityInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [action, setAction] = useState<SecurityAction | null>(null);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const recoveryTrigger = useRef<HTMLButtonElement>(null);
  const codePanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    api<unknown>("/api/security")
      .then((result) => {
        const parsed = securityInfoSchema.parse(result);
        if (active) {
          setInfo(parsed);
          setLoadError("");
        }
      })
      .catch(() => {
        if (active)
          setLoadError("Account security could not be loaded. Try again.");
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  useEffect(() => {
    if (recoveryCode) codePanel.current?.focus();
  }, [recoveryCode]);
  const openAction = (next: SecurityAction, element: HTMLElement) => {
    trigger.current = element;
    setNotice("");
    setAction(next);
  };
  const closeAction = () => {
    setAction(null);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
      else heading.current?.focus();
    });
  };
  const submit = async (currentPassword: string, newPassword: string) => {
    if (!action || !beginAction()) return;
    try {
      if (action.kind === "password") {
        await confirmedAction("/api/change-password", {
          currentPassword,
          newPassword,
        });
        onSignedOut(
          "Password changed. Sign in again and generate a new recovery code in Settings.",
        );
      } else if (action.kind === "recovery") {
        const result = await api<{ recoveryCode: string }>(
          "/api/recovery-code",
          "POST",
          { currentPassword },
        );
        if (
          !result ||
          typeof result.recoveryCode !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(result.recoveryCode)
        )
          throw new Error(
            "The recovery code could not be displayed. Generate a new code.",
          );
        setRecoveryCode(result.recoveryCode);
        setInfo((value) =>
          value
            ? { ...value, recoveryEnabled: true, recoveryCreatedAt: null }
            : value,
        );
        setAction(null);
        setAttempt((value) => value + 1);
      } else if (action.kind === "logout-all") {
        await confirmedAction("/api/logout-all", { currentPassword });
        onSignedOut(
          "Signed out of every browser. Connected apps have been disconnected.",
        );
      } else {
        const result = await api<{ signedOut: boolean }>(
          `/api/sessions/${encodeURIComponent(action.session.id)}`,
          "DELETE",
          { currentPassword },
        );
        if (!result || typeof result.signedOut !== "boolean")
          throw new Error(
            "Session status could not be confirmed. Reload Settings to check.",
          );
        if (result.signedOut) {
          onSignedOut("This browser session was signed out.");
        } else {
          setInfo((value) =>
            value
              ? {
                  ...value,
                  sessions: value.sessions.filter(
                    (session) => session.id !== action.session.id,
                  ),
                }
              : value,
          );
          setNotice("Browser session revoked.");
          closeAction();
          setAttempt((value) => value + 1);
        }
      }
    } finally {
      endAction();
    }
  };
  return (
    <section
      className="settings-section security-settings"
      aria-labelledby="settings-security"
    >
      <h3 id="settings-security" tabIndex={-1} ref={heading}>
        <ShieldCheck size={17} />
        Account security
      </h3>
      <ErrorMessage text={loadError} />
      {loadError && (
        <button
          disabled={disabled}
          onClick={() => {
            setLoadError("");
            setAttempt((value) => value + 1);
          }}
        >
          Retry account security
        </button>
      )}
      {!info && !loadError && (
        <div className="settings-loading" role="status">
          <LoaderCircle className="spin" size={17} />
          Loading account security
        </div>
      )}
      {notice && (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      )}
      {info && (
        <>
          <div className="security-group">
            <h4>
              <KeyRound size={15} />
              Password
            </h4>
            <p>Use a unique password for your private library.</p>
            <button
              disabled={disabled || Boolean(action) || Boolean(recoveryCode)}
              onClick={(event) =>
                openAction({ kind: "password" }, event.currentTarget)
              }
            >
              Change password
            </button>
          </div>
          <div className="security-group">
            <h4>Recovery code</h4>
            <p>
              {info.recoveryEnabled
                ? "A recovery code is ready to use once."
                : "No recovery code is configured. Save one now so you can reset a forgotten password."}
              {info.recoveryEnabled && info.recoveryCreatedAt
                ? ` Created ${timestamp(info.recoveryCreatedAt)}.`
                : ""}
            </p>
            <p>
              Keep it outside Drop It, such as in a password manager or a safe
              offline copy. There is no email recovery.
            </p>
            {recoveryCode ? (
              <div
                className="recovery-code-panel"
                ref={codePanel}
                tabIndex={-1}
                role="group"
                aria-label="New recovery code"
              >
                <h4>Save this code now</h4>
                <p>
                  This is the only time the full code is shown. Your previous
                  code no longer works.
                </p>
                <code className="recovery-code">{recoveryCode}</code>
                <button
                  onClick={() => {
                    setRecoveryCode("");
                    setNotice(
                      "Recovery code hidden. Keep your saved copy safe.",
                    );
                    requestAnimationFrame(() =>
                      recoveryTrigger.current?.focus(),
                    );
                  }}
                >
                  I saved this code
                </button>
              </div>
            ) : (
              <button
                ref={recoveryTrigger}
                disabled={disabled || Boolean(action)}
                onClick={(event) =>
                  openAction({ kind: "recovery" }, event.currentTarget)
                }
              >
                {info.recoveryEnabled
                  ? "Replace recovery code"
                  : "Generate recovery code"}
              </button>
            )}
          </div>
          <div className="security-group">
            <h4>
              <Monitor size={15} />
              Browser sessions
            </h4>
            <p>
              Review signed-in browsers. Revoking a browser session does not
              disconnect apps.
            </p>
            <ul className="security-sessions">
              {info.sessions.map((session) => (
                <li key={session.id}>
                  <div>
                    <strong>{session.label}</strong>
                    {session.current && (
                      <span className="current-session">This browser</span>
                    )}
                  </div>
                  <span>Signed in {timestamp(session.createdAt)}</span>
                  <span>
                    Last active {timestamp(session.lastSeenAt)} · Expires{" "}
                    {timestamp(session.expiresAt)}
                  </span>
                  <button
                    disabled={
                      disabled || Boolean(action) || Boolean(recoveryCode)
                    }
                    onClick={(event) =>
                      openAction(
                        { kind: "session", session },
                        event.currentTarget,
                      )
                    }
                    aria-label={`${session.current ? "Sign out this browser" : "Revoke session"}: ${session.label}`}
                  >
                    {session.current
                      ? "Sign out this browser"
                      : "Revoke session"}
                  </button>
                </li>
              ))}
            </ul>
            {!info.sessions.length && (
              <p>No active browser sessions were returned.</p>
            )}
            <button
              disabled={disabled || Boolean(action) || Boolean(recoveryCode)}
              onClick={(event) =>
                openAction({ kind: "logout-all" }, event.currentTarget)
              }
            >
              <LogOut size={15} />
              Sign out everywhere
            </button>
            <p className="field-note">
              Signs out all browsers, including this one, and disconnects every
              app.
            </p>
          </div>
          {action && (
            <SecurityActionForm
              key={action.kind === "session" ? action.session.id : action.kind}
              action={action}
              disabled={disabled}
              onCancel={closeAction}
              onSubmit={submit}
            />
          )}
        </>
      )}
    </section>
  );
}
