import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(executable, ["tauri", "build", "--config", "src-tauri/tauri.dev.conf.json", "--features", "dev-isolation"], {
  env: { ...process.env, CARGO_TARGET_DIR: resolve("src-tauri/target-development") },
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
