# EspHub Boards

Canonical hardware board catalog and board photos for [EspHub](https://esphub.ai).

Each board lives in its own directory under `boards/<vendor>/<slug>/`:

```text
boards/<vendor>/<slug>/
├── board.json    # Hardware specification and bootloader binding
└── photo.webp    # Optional product photo (WebP)
```

## `board.json` schema

The board ID (`<vendor>/<slug>`) and `vendor` are derived from the directory path.

```json
{
  "name": "ESP32-S3-Touch-LCD-7C-Box",
  "model": "Waveshare ESP32-S3-Touch-LCD-7C-Box",
  "product_url": "https://www.waveshare.com/esp32-s3-touch-lcd-7c-box.htm",
  "bootloader": "esp32s3-32mb-opi",
  "spec": {
    "soc": "esp32s3",
    "flash_mb": 32,
    "flash_bus": "octal",
    "psram": "octal",
    "console": "usb-serial-jtag"
  }
}
```

- `bootloader` is required and must match `spec` (`${soc}-${flash_mb}mb`, `-opi` for octal flash, `-uart` for UART console on chips whose default console is USB-Serial-JTAG).
- Optional fields: `product_url` (`https://` URL), `display_order` (integer or `null`).

## Validation and sync

- Pull requests run `npm run validate` and `npm test`.
- Merges to `main` (when `BOARDS_SYNC_ENABLED=true`) run `npm run sync`:
  1. Incrementally uploads changed `photo.webp` files to `boards/<id>.webp` in the `esphub-firmware` R2 bucket (using MD5 ETag checks and read-back verification).
  2. Upserts all boards into `esphub.boards` in a single Postgres transaction and marks removed boards `retired = true` (never physically deleting rows).
