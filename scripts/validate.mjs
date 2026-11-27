import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadBoards } from "./catalog.mjs";

const defaultBoardsDir = fileURLToPath(new URL("../boards", import.meta.url));
const boardsDir = process.argv[2] ? resolve(process.argv[2]) : defaultBoardsDir;

const boards = await loadBoards(boardsDir);
const withPhotos = boards.filter((b) => b.has_photo).length;
console.log(`Validated ${boards.length} boards (${withPhotos} with photos).`);
