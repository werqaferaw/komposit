// Loaded before every test file (package.json: node --import): the tests use a
// throwaway data folder, never the person's real settings and chats.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.KOMPOSIT_DATA_DIR) process.env.KOMPOSIT_DATA_DIR = mkdtempSync(join(tmpdir(), "komposit-test-"));
