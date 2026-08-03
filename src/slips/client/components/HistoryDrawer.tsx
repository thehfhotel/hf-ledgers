import { useEffect, useState } from "react";
import type { Property } from "../../../shared/types.ts";
import { ApiError, getHistory, pictureUrl, thumbUrl, type AttachmentWire } from "../api.ts";

interface Props {
  property: Property;
  auditKey: string;
  onClose: () => void;
}

function formatWhen(utc: string): string {
  const iso = utc.includes("T") ? utc : `${utc.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return utc;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** ประวัติ — full version history for one settlement, current AND
 * superseded versions alike (the plan's binding storage rule: history stays
 * viewable, nothing is ever deleted). Read-only — no action here writes
 * anything. */
export function HistoryDrawer({ property, auditKey, onClose }: Props) {
  const [versions, setVersions] = useState<AttachmentWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHistory(property, auditKey)
      .then((res) => {
        if (!cancelled) setVersions(res.versions);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "โหลดประวัติไม่สำเร็จ");
      });
    return () => {
      cancelled = true;
    };
  }, [property, auditKey]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-lg bg-panel shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">ประวัติสลิป · {auditKey}</h2>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-ink-muted hover:bg-tint">
            ปิด
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {error && <p className="text-sm text-bad">{error}</p>}
          {!error && versions === null && <p className="text-sm text-ink-muted">กำลังโหลด...</p>}
          {!error && versions !== null && versions.length === 0 && <p className="text-sm text-ink-muted">ยังไม่มีสลิปแนบ</p>}
          {!error && versions !== null && versions.length > 0 && (
            <ul className="flex flex-col gap-3">
              {[...versions].reverse().map((v) => (
                <li key={v.version} className={"flex gap-3 rounded-md border border-line p-2 " + (v.superseded ? "opacity-60" : "")}>
                  <a href={pictureUrl(property, auditKey, v.version)} target="_blank" rel="noreferrer">
                    <img src={thumbUrl(property, auditKey, v.version)} alt={`สลิปเวอร์ชัน ${v.version}`} className="h-16 w-16 rounded-md object-cover" />
                  </a>
                  <div className="flex flex-col gap-0.5 text-xs">
                    <span className="font-semibold text-ink">
                      เวอร์ชัน {v.version} {v.superseded && <span className="font-normal text-ink-muted">(ถูกเปลี่ยน)</span>}
                    </span>
                    <span className="text-ink-muted">
                      {v.createdBy} · {formatWhen(v.createdAt)}
                    </span>
                    {v.superseded && v.supersededAt && v.supersededBy && (
                      <span className="text-ink-muted">
                        เปลี่ยนโดย {v.supersededBy} · {formatWhen(v.supersededAt)}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
