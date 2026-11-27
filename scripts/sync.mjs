import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";
import postgres from "postgres";
import { loadBoards } from "./catalog.mjs";

const defaultBucket = "esphub-firmware";
const photoConcurrency = 8;

export async function syncPhotoToR2(client, endpoint, bucket, board, bytes) {
  const url = new URL(`${bucket}/boards/${board.id}.webp`, endpoint);
  // Single-part R2 objects normally have an MD5 ETag; compare bytes for other ETags.
  const etag = '"' + createHash("md5").update(bytes).digest("hex") + '"';
  const current = await client.fetch(url, {
    headers: { "If-None-Match": etag },
  });
  if (current.status === 304) return false;
  if (!current.ok && current.status !== 404) {
    throw new Error(`R2 read ${board.id}: HTTP ${current.status}`);
  }
  if (current.ok && bytes.equals(Buffer.from(await current.arrayBuffer()))) {
    return false;
  }

  const saved = await client.fetch(url, {
    method: "PUT",
    body: bytes,
    headers: {
      ...(current.ok
        ? { "If-Match": current.headers.get("ETag") }
        : { "If-None-Match": "*" }),
      "Content-Type": "image/webp",
    },
  });
  if (!saved.ok) {
    throw new Error(`R2 upload ${board.id}: HTTP ${saved.status}`);
  }
  const check = await client.fetch(url);
  if (!check.ok || !bytes.equals(Buffer.from(await check.arrayBuffer()))) {
    throw new Error(`R2 verification failed: ${board.id}`);
  }
  return true;
}

export async function syncPhotos(boards, { client, endpoint, bucket = defaultBucket }) {
  const photographed = boards.filter((board) => board.has_photo);
  let uploaded = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= photographed.length) return;
      const board = photographed[index];
      const bytes = await readFile(board.photo_path);
      if (await syncPhotoToR2(client, endpoint, bucket, board, bytes)) {
        uploaded++;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(photoConcurrency, photographed.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return { checked: photographed.length, uploaded };
}

export async function syncBoardsToDatabase(tx, boards) {
  if (!boards.length) {
    throw new Error("Refusing to sync an empty board list");
  }
  await tx`SELECT pg_advisory_xact_lock(hashtext('esphub.boards'))`;
  const rows = boards.map(({ photo_path: _photoPath, ...row }) => row);
  const ids = rows.map((row) => row.id);

  const upserted = await tx`
    INSERT INTO esphub.boards (
      id, vendor, name, model, soc, flash_mb, flash_bus, psram, console,
      bootloader, product_url, has_photo, preview, retired, display_order, updated_at
    )
    SELECT
      id, vendor, name, model, soc, flash_mb, flash_bus, psram, console,
      bootloader, product_url, has_photo, preview, false, display_order, now()
    FROM jsonb_to_recordset(${tx.json(rows)}::jsonb) AS b(
      id text,
      vendor text,
      name text,
      model text,
      soc text,
      flash_mb integer,
      flash_bus text,
      psram text,
      console text,
      bootloader text,
      product_url text,
      has_photo boolean,
      preview boolean,
      display_order integer
    )
    ON CONFLICT (id) DO UPDATE SET
      vendor = excluded.vendor,
      name = excluded.name,
      model = excluded.model,
      soc = excluded.soc,
      flash_mb = excluded.flash_mb,
      flash_bus = excluded.flash_bus,
      psram = excluded.psram,
      console = excluded.console,
      bootloader = excluded.bootloader,
      product_url = excluded.product_url,
      has_photo = excluded.has_photo,
      preview = excluded.preview,
      retired = false,
      display_order = excluded.display_order,
      updated_at = now()
    WHERE (
      esphub.boards.vendor,
      esphub.boards.name,
      esphub.boards.model,
      esphub.boards.soc,
      esphub.boards.flash_mb,
      esphub.boards.flash_bus,
      esphub.boards.psram,
      esphub.boards.console,
      esphub.boards.bootloader,
      esphub.boards.product_url,
      esphub.boards.has_photo,
      esphub.boards.preview,
      esphub.boards.retired,
      esphub.boards.display_order
    ) IS DISTINCT FROM (
      excluded.vendor,
      excluded.name,
      excluded.model,
      excluded.soc,
      excluded.flash_mb,
      excluded.flash_bus,
      excluded.psram,
      excluded.console,
      excluded.bootloader,
      excluded.product_url,
      excluded.has_photo,
      excluded.preview,
      false,
      excluded.display_order
    )
    RETURNING id`;

  const retired = await tx`
    UPDATE esphub.boards
    SET retired = true, updated_at = now()
    WHERE NOT retired AND id <> ALL(${ids}::text[])
    RETURNING id`;

  return {
    total: rows.length,
    changed: upserted.length,
    retired: retired.length,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const boardsDir = fileURLToPath(new URL("../boards", import.meta.url));
  const boards = await loadBoards(boardsDir);

  const endpoint = process.env.FIRMWARE_R2_ENDPOINT;
  const accessKeyId =
    process.env.FIRMWARE_R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.FIRMWARE_R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const databaseUrl = process.env.BOARDS_DATABASE_URL;
  const bucket = process.env.FIRMWARE_R2_BUCKET || defaultBucket;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing R2 credentials (FIRMWARE_R2_ENDPOINT, FIRMWARE_R2_ACCESS_KEY_ID, FIRMWARE_R2_SECRET_ACCESS_KEY)",
    );
  }
  if (!databaseUrl) {
    throw new Error("Missing BOARDS_DATABASE_URL");
  }

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });

  // 1. Sync photos to R2 first so has_photo = true never precedes object availability.
  const photos = await syncPhotos(boards, { client, endpoint, bucket });
  console.log(
    `Photos: checked ${photos.checked}, uploaded ${photos.uploaded}.`,
  );

  // 2. Sync all boards into esphub.boards inside a single transaction.
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const db = await sql.begin((tx) => syncBoardsToDatabase(tx, boards));
    console.log(
      `Database: synced ${db.total} boards (${db.changed} changed, ${db.retired} retired).`,
    );
  } finally {
    await sql.end();
  }
}
