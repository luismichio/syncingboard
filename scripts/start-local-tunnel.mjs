import { spawn } from "node:child_process";
import fs from "node:fs";

const withTauri = process.argv.includes("--tauri") || process.argv.includes("tauri") || process.argv.includes("--with-tauri");

console.log(`🚀 Starting SyncingBoard local server & Cloudflare Tunnel${withTauri ? " (+ Tauri SyncBridge)" : ""}...\n`);

// 1. Find cloudflared executable
let cloudflaredBin = "cloudflared";
if (process.platform === "win32") {
  const winPaths = [
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
  ];
  for (const p of winPaths) {
    if (fs.existsSync(p)) {
      cloudflaredBin = p;
      break;
    }
  }
}

// 2. Spawn Next.js dev server
const devProcess = spawn("yarn", ["dev"], {
  stdio: "inherit",
  shell: true,
});

// 3. Spawn cloudflared tunnel
const tunnelProcess = spawn(`"${cloudflaredBin}"`, ["tunnel", "run", "syncingboard-dev"], {
  stdio: "inherit",
  shell: true,
});

// 4. Optionally spawn Tauri dev server
let tauriProcess = null;
if (withTauri) {
  console.log("⚡ Launching Tauri SyncBridge desktop app...\n");
  tauriProcess = spawn("yarn", ["--cwd", "tauri-bridge", "tauri", "dev"], {
    stdio: "inherit",
    shell: true,
  });
}

function cleanup() {
  console.log("\n🧹 Shutting down local server, tunnel, and Tauri...");
  try {
    devProcess.kill("SIGTERM");
  } catch (e) {}
  try {
    tunnelProcess.kill("SIGTERM");
  } catch (e) {}
  if (tauriProcess) {
    try {
      tauriProcess.kill("SIGTERM");
    } catch (e) {}
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
