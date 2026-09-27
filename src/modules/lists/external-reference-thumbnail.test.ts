import { describe, expect, it, vi } from "vitest";
import { createExternalReferenceThumbnailService, ExternalReferenceThumbnailUnavailableError, type ExternalThumbnailObjects, type ExternalThumbnailStore } from "./external-reference-thumbnail";

const ref = { provider: "bgg" as const, sourceId: "13", medium: "board_game" as const };
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));

function setup(fetcher: typeof fetch = vi.fn(async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }))) {
  const claim: ExternalThumbnailStore["claim"] = async (_ref, lease) => ({ status: "claimed", identityId: "11111111-1111-4111-8111-111111111111", leaseToken: lease.token });
  const store: ExternalThumbnailStore = {
    claim: vi.fn(claim),
    complete: vi.fn(async () => true), fail: vi.fn(async () => undefined),
  };
  const objects: ExternalThumbnailObjects = { upload: vi.fn(async () => undefined), issueRead: vi.fn(async () => "https://storage.example.test/signed") };
  return { service: createExternalReferenceThumbnailService({ store, objects, fetcher }), store, objects };
}

describe("external reference thumbnail", () => {
  it("stores only a local WebP derivative and marks the claim ready", async () => {
    const { service, store, objects } = setup();
    await service.ensure(ref, "https://cf.geekdo-images.com/catan.png");
    expect(objects.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^external-reference-thumbnails\/11111111-1111-4111-8111-111111111111\/[0-9a-f]{64}\.webp$/),
      expect.any(Uint8Array),
    );
    const bytes = vi.mocked(objects.upload).mock.calls[0]![1];
    expect(Buffer.from(bytes).subarray(8, 12).toString()).toBe("WEBP");
    expect(store.complete).toHaveBeenCalledOnce();
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("rejects redirects outside the provider CDN and records failure", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/cover.png" } }));
    const { service, store } = setup(fetcher);
    await expect(service.ensure(ref, "https://cf.geekdo-images.com/catan.png")).rejects.toBeInstanceOf(ExternalReferenceThumbnailUnavailableError);
    expect(store.fail).toHaveBeenCalledOnce();
  });
});
