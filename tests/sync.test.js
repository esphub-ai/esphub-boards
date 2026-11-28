import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { syncBoardsToDatabase, syncPhotoToR2 } from "../scripts/sync.mjs";

test("syncPhotoToR2 skips matching ETag, uploads changed bytes, and verifies read-back", async () => {
  const bytes = Buffer.from("RIFF\x0c\x00\x00\x00WEBPVP8L\x00\x00\x00\x00", "latin1");
  const etag = '"' + createHash("md5").update(bytes).digest("hex") + '"';
  const stored = new Map();
  const calls = [];
  const client = {
    async fetch(url, init = {}) {
      const method = init.method ?? "GET";
      const key = new URL(url).pathname;
      calls.push(`${method} ${key}`);
      if (method === "GET") {
        const entry = stored.get(key);
        if (!entry) return new Response(null, { status: 404 });
        if (init.headers?.["If-None-Match"] === entry.etag) {
          return new Response(null, { status: 304 });
        }
        return new Response(entry.bytes, { status: 200, headers: { ETag: entry.etag } });
      }
      if (method === "PUT") {
        const body = Buffer.from(init.body);
        stored.set(key, {
          bytes: body,
          etag: '"' + createHash("md5").update(body).digest("hex") + '"',
        });
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };

  const board = { id: "acme/board-a" };
  const first = await syncPhotoToR2(
    client,
    "https://example.r2.cloudflarestorage.com/",
    "esphub-firmware",
    board,
    bytes,
  );
  assert.equal(first, true);
  assert.deepEqual(calls, [
    "GET /esphub-firmware/boards/acme/board-a.webp",
    "PUT /esphub-firmware/boards/acme/board-a.webp",
    "GET /esphub-firmware/boards/acme/board-a.webp",
  ]);
  assert.equal(stored.get("/esphub-firmware/boards/acme/board-a.webp").etag, etag);

  calls.length = 0;
  const second = await syncPhotoToR2(
    client,
    "https://example.r2.cloudflarestorage.com/",
    "esphub-firmware",
    board,
    bytes,
  );
  assert.equal(second, false);
  assert.deepEqual(calls, ["GET /esphub-firmware/boards/acme/board-a.webp"]);
});

test(
  "syncBoardsToDatabase upserts boards, retires removed boards, and reactivates restored boards",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1, prepare: false });
    const rollback = Symbol("rollback");
    try {
      await sql.begin(async (tx) => {
        const base = {
          vendor: "sync-test",
          name: "Board A",
          model: "Sync Test Board A",
          soc: "esp32s3",
          flash_mb: 16,
          flash_bus: "quad",
          psram: "octal",
          console: "usb-serial-jtag",
          bootloader: "esp32s3-16mb",
          product_url: "https://example.com/a",
          has_photo: true,
          display_order: null,
          photo_path: "/tmp/fake.webp",
        };
        const boardA = { ...base, id: "sync-test/board-a" };
        const boardB = { ...base, id: "sync-test/board-b", name: "Board B", model: "Sync Test Board B" };

        const r1 = await syncBoardsToDatabase(tx, [boardA, boardB]);
        assert.equal(r1.total, 2);
        assert.equal(r1.changed, 2);

        // Second identical sync reports 0 changes
        const r2 = await syncBoardsToDatabase(tx, [boardA, boardB]);
        assert.equal(r2.changed, 0);
        assert.equal(r2.retired, 0);

        // Removing boardB retires it rather than deleting it
        const r3 = await syncBoardsToDatabase(tx, [{ ...boardA, psram: "quad" }]);
        assert.equal(r3.changed, 1);
        assert.equal(r3.retired, 1);

        const [rowA] = await tx`SELECT psram, retired FROM esphub.boards WHERE id = 'sync-test/board-a'`;
        const [rowB] = await tx`SELECT retired FROM esphub.boards WHERE id = 'sync-test/board-b'`;
        assert.equal(rowA.psram, "quad");
        assert.equal(rowA.retired, false);
        assert.equal(rowB.retired, true);

        // Restoring boardB clears retired
        const r4 = await syncBoardsToDatabase(tx, [{ ...boardA, psram: "quad" }, boardB]);
        assert.equal(r4.changed, 1);
        assert.equal(r4.retired, 0);
        const [rowB2] = await tx`SELECT retired FROM esphub.boards WHERE id = 'sync-test/board-b'`;
        assert.equal(rowB2.retired, false);

        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await sql.end();
    }
  },
);
