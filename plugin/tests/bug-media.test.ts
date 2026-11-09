import { test } from "node:test";
import assert from "node:assert/strict";
import { BugMediaStore } from "../src/adapters/bug-media.ts";
import { ONES, Transport } from "../src/adapters/http.ts";

function fixture() {
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(700000),
  ]);
  let origin = ONES,
    mime = "image/png",
    size = bytes.length,
    redirect = false;
  const calls: string[] = [];
  const store = new BugMediaStore(
    new Transport(ONES, async (url, init) => {
      const path = new URL(String(url));
      calls.push(path.pathname);
      if (path.pathname.includes("/res/attachment/")) {
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-secret");
        return Response.json({
          uuid: "resource",
          mime,
          size,
          url: `${origin}/api/project/media?token=fixture-signature`,
        });
      }
      assert.equal(new Headers(init?.headers).get("Authorization"), null);
      assert.equal(init?.redirect, "manual");
      return new Response(bytes, {
        status: redirect ? 302 : 200,
        headers: { "Content-Type": mime },
      });
    }),
    "team",
    "fixture-secret",
  );
  store.allow(["resource"]);
  return {
    store,
    bytes,
    calls,
    external() {
      origin = "https://untrusted.invalid";
    },
    unsupported() {
      mime = "image/svg+xml";
    },
    oversized() {
      size = 33554433;
    },
    redirect() {
      redirect = true;
    },
  };
}

test("TC-PLUGIN-008-media: registered media uses authenticated metadata then credential-free bounded chunks", async () => {
  const f = fixture();
  const first = await f.store.read(f.store.detailId, "resource", 0);
  assert.equal(first.next, 524288);
  const last = await f.store.read(f.store.detailId, "resource", first.next!);
  assert.equal(last.next, null);
  assert.deepEqual(
    Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(last.data, "base64")]),
    f.bytes,
  );
  assert.equal(f.calls.length, 2);
  assert.ok(!JSON.stringify({ ...first, data: "" }).includes("token"));
});

test("TC-PLUGIN-008-media: arbitrary resource, wrong detail and disposed handles cannot read bytes", async () => {
  const f = fixture();
  await assert.rejects(() => f.store.read(f.store.detailId, "other", 0), /不属于/);
  await assert.rejects(() => f.store.read("another-detail", "resource", 0), /关闭或过期/);
  await assert.rejects(() => f.store.read(f.store.detailId, "resource", 1), /分块位置/);
  f.store.dispose();
  await assert.rejects(() => f.store.read(f.store.detailId, "resource", 0), /关闭或过期/);
  assert.equal(f.calls.length, 0);
});

test("TC-PLUGIN-008-media: cross-origin, unsupported MIME, excessive size and redirects fail closed", async () => {
  for (const change of ["external", "unsupported", "oversized", "redirect"] as const) {
    const f = fixture();
    f[change]();
    await assert.rejects(() => f.store.read(f.store.detailId, "resource", 0));
    assert.equal(f.calls.length, change === "redirect" ? 2 : 1);
  }
});
