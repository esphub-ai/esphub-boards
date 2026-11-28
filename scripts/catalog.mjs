import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const segmentPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const boardIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const socPattern = /^esp32[a-z0-9]*$/;
export const bootloaderPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const allowedBoardKeys = new Set([
  "name",
  "model",
  "product_url",
  "bootloader",
  "spec",
  "display_order",
]);
const allowedSpecKeys = new Set([
  "soc",
  "flash_mb",
  "flash_bus",
  "psram",
  "console",
]);
const allowedDirEntries = new Set(["board.json", "photo.webp"]);
const uartDefaultSocs = new Set(["esp32", "esp32s31"]);

export function validateWebp(bytes, label = "photo.webp") {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    !["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
  ) {
    throw new Error(`Invalid WebP image: ${label}`);
  }
}

export function validateBoardRecord(id, raw) {
  if (!boardIdPattern.test(id)) {
    throw new Error(`Invalid board ID: ${id}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Board ${id}: board.json must be a JSON object`);
  }
  for (const key of Object.keys(raw)) {
    if (!allowedBoardKeys.has(key)) {
      throw new Error(`Board ${id}: unexpected field "${key}"`);
    }
  }

  const { name, model, bootloader, spec } = raw;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`Board ${id}: name must be a non-empty string`);
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`Board ${id}: model must be a non-empty string`);
  }
  if (typeof bootloader !== "string" || !bootloaderPattern.test(bootloader)) {
    throw new Error(`Board ${id}: bootloader must be a non-empty slug`);
  }

  let product_url = null;
  if (raw.product_url !== undefined && raw.product_url !== null) {
    if (typeof raw.product_url !== "string" || !raw.product_url.startsWith("https://")) {
      throw new Error(`Board ${id}: product_url must start with https://`);
    }
    let parsed;
    try {
      parsed = new URL(raw.product_url);
    } catch {
      throw new Error(`Board ${id}: product_url is not a valid URL`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`Board ${id}: product_url must use https://`);
    }
    product_url = raw.product_url;
  }

  let display_order = null;
  if (raw.display_order !== undefined && raw.display_order !== null) {
    if (!Number.isSafeInteger(raw.display_order)) {
      throw new Error(`Board ${id}: display_order must be an integer or null`);
    }
    display_order = raw.display_order;
  }

  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`Board ${id}: spec must be a JSON object`);
  }
  for (const key of Object.keys(spec)) {
    if (!allowedSpecKeys.has(key)) {
      throw new Error(`Board ${id}: unexpected spec field "${key}"`);
    }
  }

  const { soc, flash_mb, flash_bus, psram, console: consoleType } = spec;
  if (typeof soc !== "string" || !socPattern.test(soc)) {
    throw new Error(`Board ${id}: invalid spec.soc "${soc}"`);
  }
  if (!Number.isSafeInteger(flash_mb) || flash_mb < 8) {
    throw new Error(`Board ${id}: spec.flash_mb must be an integer >= 8`);
  }
  if (flash_bus !== "quad" && flash_bus !== "octal") {
    throw new Error(`Board ${id}: spec.flash_bus must be "quad" or "octal"`);
  }
  if (psram !== null && psram !== "quad" && psram !== "octal") {
    throw new Error(`Board ${id}: spec.psram must be "quad", "octal", or null`);
  }
  if (consoleType !== "usb-serial-jtag" && consoleType !== "uart") {
    throw new Error(`Board ${id}: spec.console must be "usb-serial-jtag" or "uart"`);
  }

  const expectedPrefix = `${soc}-${flash_mb}mb`;
  if (bootloader !== expectedPrefix && !bootloader.startsWith(expectedPrefix + "-")) {
    throw new Error(
      `Board ${id}: bootloader "${bootloader}" does not match spec prefix "${expectedPrefix}"`,
    );
  }
  const suffixTags = bootloader
    .slice(expectedPrefix.length)
    .split("-")
    .filter(Boolean);
  const hasOpi = suffixTags.includes("opi");
  if (hasOpi !== (flash_bus === "octal")) {
    throw new Error(
      `Board ${id}: bootloader "${bootloader}" conflicts with spec.flash_bus "${flash_bus}"`,
    );
  }
  const hasUartTag = suffixTags.includes("uart");
  if (uartDefaultSocs.has(soc)) {
    if (consoleType !== "uart") {
      throw new Error(`Board ${id}: ${soc} requires spec.console "uart"`);
    }
    if (hasUartTag) {
      throw new Error(`Board ${id}: ${soc} bootloader "${bootloader}" must not include redundant "-uart"`);
    }
  } else if (hasUartTag !== (consoleType === "uart")) {
    throw new Error(
      `Board ${id}: bootloader "${bootloader}" conflicts with spec.console "${consoleType}"`,
    );
  }

  const vendor = id.split("/")[0];
  return {
    id,
    vendor,
    name: name.trim(),
    model: model.trim(),
    soc,
    flash_mb,
    flash_bus,
    psram,
    console: consoleType,
    bootloader,
    product_url,
    display_order,
  };
}

export async function loadBoards(boardsDir) {
  const vendors = (await readdir(boardsDir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const boards = [];

  for (const vendorEntry of vendors) {
    if (!vendorEntry.isDirectory() || !segmentPattern.test(vendorEntry.name)) {
      throw new Error(`Unexpected entry in boards/: ${vendorEntry.name}`);
    }
    const vendorDir = join(boardsDir, vendorEntry.name);
    const projects = (await readdir(vendorDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (!projects.length) {
      throw new Error(`Empty vendor directory: ${vendorEntry.name}`);
    }
    for (const projectEntry of projects) {
      if (!projectEntry.isDirectory() || !segmentPattern.test(projectEntry.name)) {
        throw new Error(
          `Unexpected entry in boards/${vendorEntry.name}/: ${projectEntry.name}`,
        );
      }
      const id = `${vendorEntry.name}/${projectEntry.name}`;
      const boardDir = join(vendorDir, projectEntry.name);
      const files = await readdir(boardDir, { withFileTypes: true });
      let hasBoardJson = false;
      let photoPath = null;

      for (const fileEntry of files) {
        if (!allowedDirEntries.has(fileEntry.name)) {
          throw new Error(`Unexpected file in boards/${id}/: ${fileEntry.name}`);
        }
        const fullPath = join(boardDir, fileEntry.name);
        if (!(await lstat(fullPath)).isFile()) {
          throw new Error(`Expected regular file: boards/${id}/${fileEntry.name}`);
        }
        if (fileEntry.name === "board.json") hasBoardJson = true;
        if (fileEntry.name === "photo.webp") photoPath = fullPath;
      }

      if (!hasBoardJson) {
        throw new Error(`Missing board.json in boards/${id}/`);
      }

      let raw;
      try {
        raw = JSON.parse(await readFile(join(boardDir, "board.json"), "utf8"));
      } catch (error) {
        throw new Error(`Invalid JSON in boards/${id}/board.json: ${error.message}`);
      }
      const record = validateBoardRecord(id, raw);

      if (photoPath) {
        const bytes = await readFile(photoPath);
        validateWebp(bytes, `boards/${id}/photo.webp`);
      }

      boards.push({
        ...record,
        has_photo: Boolean(photoPath),
        photo_path: photoPath,
      });
    }
  }

  if (!boards.length) {
    throw new Error("Board catalog is empty");
  }
  return boards;
}
