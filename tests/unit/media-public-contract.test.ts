import { describe, expect, it } from "vitest";
import type { BeginMediaUploadResult, MediaAsset } from "@/modules/media";

// @ts-expect-error 持久層介面只能由明確的 internal 入口匯入。
import type { MediaStore } from "@/modules/media";
// @ts-expect-error Storage adapter 只能由明確的 internal 入口匯入。
import type { MediaObjectStore } from "@/modules/media";
// @ts-expect-error ingest 狀態帳不是瀏覽器公開契約。
import type { MediaIngest } from "@/modules/media";
type HasKey<Value, Key extends PropertyKey> = Key extends keyof Value ? true : false;
type UploadGrant = Extract<BeginMediaUploadResult, Readonly<{ status: "upload_grant" }>>;
type PublicRuntimeExport = keyof typeof import("@/modules/media");

const grantHidesObjectPath: HasKey<UploadGrant, "objectPath"> = false;
const uploadCapabilityIsExecutable: UploadGrant["upload"]["endpoint"] = "https://storage.example.test/upload/resumable/sign";
const assetHidesObjectPath: HasKey<MediaAsset, "originalObjectPath"> = false;
const publicEntryHidesComposition: Extract<PublicRuntimeExport, "createMediaService" | "createInMemoryMediaStore"> extends never ? true : false = true;
const hiddenInternalTypes: [MediaStore, MediaObjectStore, MediaIngest] | null = null;

describe("媒體模組公開契約", () => {
  it("不讓瀏覽器 DTO 帶出 Storage object path", () => {
    expect(grantHidesObjectPath).toBe(false);
    expect(uploadCapabilityIsExecutable).toContain("/upload/");
    expect(assetHidesObjectPath).toBe(false);
    expect(publicEntryHidesComposition).toBe(true);
    expect(hiddenInternalTypes).toBeNull();
  });
});
