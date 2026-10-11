/* Общая подготовка для unit-тестов: stats.js при импорте читает STATS_FILE,
   а тестам нельзя трогать боевой ./data/stats.json. Импортировать ПЕРВЫМ,
   до любых модулей lib/ (поэтому они грузятся через await import в тестах). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "void-test-"));
process.env.STATS_FILE = join(dir, "stats.json");
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
