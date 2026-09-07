"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

type ThumbnailState = "pending" | "processing" | "ready" | "failed" | null;

export function PrivateCoverImage({ assetId, state = null, alt, className }: Readonly<{ assetId?: string | null; state?: ThumbnailState; alt: string; className: string }>) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!failed || state !== "ready" || attempt >= 1) return;
    const timer = window.setTimeout(() => { setFailed(false); setAttempt((current) => current + 1); }, 1_500);
    return () => window.clearTimeout(timer);
  }, [attempt, failed, state]);
  const placeholder = !assetId
    ? "尚無可用封面"
    : state === "failed"
      ? "封面縮圖處理失敗，請開啟遊戲重試"
      : state === "pending" || state === "processing"
        ? "封面縮圖處理中，請開啟遊戲查看狀態"
        : "封面暫時無法載入，請稍後重試";
  return <div className={`relative overflow-hidden bg-emerald-50 ${className}`}>
    {assetId && state === "ready" && !failed
      ? <Image
          unoptimized
          fill
          sizes="(max-width: 640px) 50vw, 256px"
          src={`/api/private/media/assets/${assetId}/thumbnail?attempt=${attempt}`}
          alt={alt}
          className="object-cover"
          onError={() => setFailed(true)}
        />
      : <div aria-label={`封面狀態：${placeholder}`} className="flex h-full items-center justify-center px-4 text-center text-xs text-emerald-900/55">{placeholder}</div>}
  </div>;
}
