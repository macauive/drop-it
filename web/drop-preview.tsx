import { useState } from "react";
import { FileText, Image as ImageIcon, Link as LinkIcon } from "lucide-react";

export function DropPreview({
  sourceId,
  hasImage,
  hasLink,
  enabled,
}: {
  sourceId: string;
  hasImage: boolean;
  hasLink: boolean;
  enabled: boolean;
}) {
  const [failedSource, setFailedSource] = useState("");
  const preview = enabled && hasImage && failedSource !== sourceId;
  return (
    <span className="drop-preview" aria-hidden="true">
      {preview ? (
        <img
          className="drop-thumbnail"
          src={`/api/sources/${encodeURIComponent(sourceId)}/thumbnail`}
          alt=""
          width={72}
          height={56}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSource(sourceId)}
        />
      ) : (
        <span className="item-icon">
          {hasImage ? (
            <ImageIcon size={21} />
          ) : hasLink ? (
            <LinkIcon size={21} />
          ) : (
            <FileText size={21} />
          )}
        </span>
      )}
    </span>
  );
}
