import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadBoards, validateBoardRecord, validateWebp } from "../scripts/catalog.mjs";

const validBoard = {
  name: "ESP32-S3-Touch-LCD-7C-Box",
  model: "Waveshare ESP32-S3-Touch-LCD-7C-Box",
  product_url: "https://www.waveshare.com/esp32-s3-touch-lcd-7c-box.htm",
  bootloader: "esp32s3-32mb-opi",
  spec: {
    soc: "esp32s3",
    flash_mb: 32,
    flash_bus: "octal",
    psram: "octal",
    console: "usb-serial-jtag",
  },
};

function minimalWebp() {
  const payload = Buffer.alloc(12);
  const buf = Buffer.alloc(20);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8L", 12, "ascii");
  payload.copy(buf, 16, 0, 4);
  return buf;
}

test("repository boards catalog passes full validation", async () => {
  const boardsDir = fileURLToPath(new URL("../boards", import.meta.url));
  const boards = await loadBoards(boardsDir);
  assert.ok(boards.length >= 176);
  const mosaico = boards.find((b) => b.id === "espressif/esp-mosaico");
  assert.equal(mosaico?.preview, true);
  assert.equal(mosaico?.console, "uart");
  const noPhoto = boards.find((b) => b.id === "lilygo/t-embed-plus-v2");
  assert.equal(noPhoto?.has_photo, false);
});

test("validateBoardRecord enforces required bootloader and spec consistency", () => {
  const ok = validateBoardRecord("waveshare/esp32-s3-touch-lcd-7c-box", validBoard);
  assert.equal(ok.vendor, "waveshare");
  assert.equal(ok.flash_bus, "octal");
  assert.equal(ok.preview, false);
  assert.equal(ok.display_order, null);

  // Null or missing bootloader is rejected
  assert.throws(() => validateBoardRecord("waveshare/test", { ...validBoard, bootloader: null }));
  assert.throws(() => validateBoardRecord("waveshare/test", { ...validBoard, bootloader: "" }));

  // Unexpected fields (including id in board.json) are rejected
  assert.throws(() => validateBoardRecord("waveshare/test", { ...validBoard, id: "waveshare/test" }));

  // Bootloader / spec mismatches are rejected
  assert.throws(() =>
    validateBoardRecord("waveshare/test", { ...validBoard, bootloader: "esp32s3-16mb-opi" }),
  );
  assert.throws(() =>
    validateBoardRecord("waveshare/test", {
      ...validBoard,
      spec: { ...validBoard.spec, flash_bus: "quad" },
    }),
  );
  assert.throws(() =>
    validateBoardRecord("waveshare/test", {
      ...validBoard,
      bootloader: "esp32s3-32mb-uart",
      spec: { ...validBoard.spec, flash_bus: "quad", console: "usb-serial-jtag" },
    }),
  );
  assert.throws(() =>
    validateBoardRecord("m5stack/core2", {
      ...validBoard,
      bootloader: "esp32-16mb",
      spec: { soc: "esp32", flash_mb: 16, flash_bus: "quad", psram: "quad", console: "usb-serial-jtag" },
    }),
  );
  assert.throws(() =>
    validateBoardRecord("m5stack/core2", {
      ...validBoard,
      bootloader: "esp32-16mb-uart",
      spec: { soc: "esp32", flash_mb: 16, flash_bus: "quad", psram: "quad", console: "uart" },
    }),
  );

  // Non-HTTPS product_url is rejected
  assert.throws(() =>
    validateBoardRecord("waveshare/test", { ...validBoard, product_url: "http://example.com" }),
  );
});

test("validateWebp and loadBoards reject invalid photos or unexpected files", async () => {
  validateWebp(minimalWebp());
  assert.throws(() => validateWebp(Buffer.from("not a webp")));

  const dir = await mkdtemp(join(tmpdir(), "esphub-boards-test-"));
  try {
    const boardDir = join(dir, "acme", "devkit");
    await mkdir(boardDir, { recursive: true });
    await writeFile(join(boardDir, "board.json"), JSON.stringify(validBoard));
    await writeFile(join(boardDir, "photo.webp"), minimalWebp());
    const [board] = await loadBoards(dir);
    assert.equal(board.id, "acme/devkit");
    assert.equal(board.has_photo, true);

    await writeFile(join(boardDir, "extra.txt"), "nope");
    await assert.rejects(() => loadBoards(dir), /Unexpected file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
