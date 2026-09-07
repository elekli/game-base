"use client";

import Image from "next/image";
import { useState } from "react";

export function PrivateCoverImage({ assetId, alt, className }: Readonly<{ assetId?: string | null; alt: string; className: string }>) {
  const [failed, setFailed] = useState(false);
  return <div className={`relative overflow-hidden bg-emerald-50 ${className}`}>
    {assetId && !failed
      ? <Image
          unoptimized
          fill
          sizes="(max-width: 640px) 50vw, 256px"
          src={`/api/private/media/assets/${assetId}/thumbnail`}
          alt={alt}
          className="object-cover"
          onError={() => setFailed(true)}
        />
      : <div aria-label={`${alt}尚無可用封面`} className="flex h-full items-center justify-center text-xs text-emerald-900/55">尚無可用封面</div>}
  </div>;
}
