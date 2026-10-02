import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, LoaderCircle, Upload } from "lucide-react";
import { api, browserRequest } from "./client.js";
import {
  maxArchiveBytes,
  importPreviewSchema,
  importResultSchema,
  type ImportPreview,
} from "../shared/portable.js";

const size = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
export function PortabilitySettings({
  disabled = false,
  onChange,
  onBusyChange,
}: {
  disabled?: boolean;
  onChange?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const currentPreview = useRef<ImportPreview | null>(null);
  const setActive = (active: boolean) => {
    setBusy(active);
    onBusyChange?.(active);
  };
  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (lock.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => {
      window.removeEventListener("beforeunload", preventUnload);
      if (currentPreview.current && !lock.current)
        void browserRequest(
          `/api/portability/preview/${currentPreview.current.previewId}`,
          { method: "DELETE", keepalive: true },
        ).catch(() => undefined);
    };
  }, []);
  const discard = async () => {
    if (!currentPreview.current) return;
    await api(
      `/api/portability/preview/${currentPreview.current.previewId}`,
      "DELETE",
    );
    currentPreview.current = null;
    setPreview(null);
  };
  const readPreview = async () => {
    if (!file || disabled || lock.current) return;
    lock.current = true;
    setActive(true);
    setError("");
    setNotice("");
    try {
      if (file.size > maxArchiveBytes || !file.size)
        throw new Error("Choose a nonempty Drop It export under 512 MB.");
      const extension = file.name.toLowerCase().split(".").at(-1);
      if (extension !== "ndjson" && extension !== "json")
        throw new Error("Choose a Drop It .ndjson or .json export.");
      await discard();
      const response = await browserRequest("/api/portability/preview", {
        method: "POST",
        headers: {
          "Content-Type":
            extension === "ndjson"
              ? "application/x-ndjson"
              : "application/json",
        },
        body: file,
      });
      const result = await response.json().catch(() => {
        throw new Error("The archive could not be checked. Try again.");
      });
      if (!response.ok)
        throw new Error(
          result.error ?? "The archive could not be checked. Try again.",
        );
      const parsed = importPreviewSchema.safeParse(result);
      if (!parsed.success)
        throw new Error(
          "The import preview could not be read. Try again after its 15-minute expiry.",
        );
      currentPreview.current = parsed.data;
      setPreview(parsed.data);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The archive could not be checked.",
      );
    } finally {
      lock.current = false;
      setActive(false);
    }
  };
  const apply = async () => {
    if (!preview || disabled || lock.current) return;
    lock.current = true;
    setActive(true);
    setError("");
    setNotice("");
    try {
      const response = await api<unknown>("/api/portability/apply", "POST", {
        previewId: preview.previewId,
        requestId: preview.requestId,
        confirm: true,
      });
      const parsed = importResultSchema.safeParse(response);
      if (!parsed.success)
        throw new Error(
          "The import result could not be confirmed. Retry to check it without adding extra copies.",
        );
      const result = parsed.data;
      setNotice(
        `${result.imported} drops imported with ${result.files} original files.${result.replayed ? " This retry confirmed the earlier import; no extra copies were added." : ""}`,
      );
      currentPreview.current = null;
      setPreview(null);
      setFile(null);
      if (input.current) input.current.value = "";
      onChange?.();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The import could not be completed. Retry to confirm its result.",
      );
    } finally {
      lock.current = false;
      setActive(false);
    }
  };
  return (
    <section
      className="settings-section"
      aria-labelledby="settings-portability"
    >
      <h3 id="settings-portability">
        <ArrowDownToLine size={17} /> Backup &amp; restore
      </h3>
      <p>
        Download a portable backup with original files, notes, bookmarks and
        unexpired Trash. It contains private content; keep it somewhere safe.
      </p>
      <a
        className="source-link"
        href="/api/portability/export"
        download="drop-it-library.ndjson"
      >
        <ArrowDownToLine size={16} /> Download portable backup
      </a>
      <p>
        Restore a Drop It backup into this account as new copies. Existing drops
        stay unchanged. Preview checks the archive and available capacity before
        you import.
      </p>
      <label>
        Backup file (.ndjson or older .json)
        <input
          ref={input}
          type="file"
          accept=".ndjson,.json,application/x-ndjson,application/json"
          disabled={disabled || busy || Boolean(preview)}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setError("");
            setNotice("");
          }}
        />
      </label>
      {!preview && (
        <button
          disabled={disabled || busy || !file}
          onClick={() => void readPreview()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Upload size={16} />
          )}
          {busy ? "Checking archive…" : "Preview import"}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      )}
      {preview && (
        <div className="security-action" aria-label="Import preview">
          <h4>Review import</h4>
          <p>
            {preview.items} drops · {preview.sources} sources · {preview.files}{" "}
            original files ({size(preview.fileBytes)})
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <p>
            Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}.
            Cancel deletes the temporary upload; otherwise it is removed after
            15 minutes.
          </p>
          <div className="actions">
            <button
              disabled={disabled || busy}
              onClick={async () => {
                if (lock.current) return;
                lock.current = true;
                setActive(true);
                setError("");
                try {
                  await discard();
                  setNotice(
                    "Import preview discarded. Your library is unchanged.",
                  );
                } catch {
                  setError(
                    "Could not discard the preview. Retry; it also expires automatically.",
                  );
                } finally {
                  lock.current = false;
                  setActive(false);
                }
              }}
            >
              Cancel import
            </button>
            <button
              className="primary"
              disabled={disabled || busy || preview.items === 0}
              onClick={() => void apply()}
            >
              {busy ? "Importing…" : `Import ${preview.items} drops as copies`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
