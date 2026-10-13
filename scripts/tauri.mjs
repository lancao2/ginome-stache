import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

const env = { ...process.env };
const launchedBySystemd = env.STACHE_SYSTEMD_LAUNCHED === "1";
let appArmorProfile = "";
try { appArmorProfile = readFileSync("/proc/self/attr/current", "utf8"); }
catch { /* AppArmor is not available on every Linux distribution. */ }
const confinedByCodeSnap = process.platform === "linux"
  && !launchedBySystemd
  && (appArmorProfile.includes("snap.code") || env.SNAP_NAME === "code");

if (process.platform === "linux") {
  // VS Code installed through Snap leaks an Ubuntu Core runtime into child
  // processes. WebKitGTK then mixes that glibc with the host libraries and
  // exits before the Tauri window can render.
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNAP"))
      delete env[key];
  }

  for (const key of [
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GSETTINGS_SCHEMA_DIR",
    "GTK_MODULES",
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GIO_MODULE_DIR",
    "LD_PRELOAD",
    "LOCPATH",
  ])
    delete env[key];

  if (env.XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG)
    env.XDG_CONFIG_DIRS = env.XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG;
  if (env.XDG_DATA_DIRS_VSCODE_SNAP_ORIG)
    env.XDG_DATA_DIRS = env.XDG_DATA_DIRS_VSCODE_SNAP_ORIG;

  // A terminal can lose the SNAP marker while retaining individual paths.
  // Strip those paths as a second line of defence.
  for (const key of ["LD_LIBRARY_PATH", "LIBRARY_PATH", "PKG_CONFIG_PATH", "PATH"]) {
    if (!env[key])
      continue;
    const clean = env[key]
      .split(":")
      .filter(path => path && !path.includes("/snap/"))
      .join(":");
    if (clean)
      env[key] = clean;
    else
      delete env[key];
  }
}

if (confinedByCodeSnap) {
  // O build usa a própria unidade para não encerrar a sessão de desenvolvimento em andamento.
  const unit = process.argv[2] === "build" ? "stache-build.service" : "stache-dev.service";
  // Clean up units created by older launcher versions and any interrupted
  // fixed-name unit before claiming the development port and Cargo lock.
  spawnSync("systemctl", [
    "--user", "stop", unit, ...(unit === "stache-dev.service" ? ["stache-dev-*.service"] : []),
  ], { stdio: "ignore" });
  const forwarded = [
    "PATH", "HOME", "USER", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "CARGO_HOME",
    "RUSTUP_HOME",
  ].flatMap(key => env[key] ? [`--setenv=${key}=${env[key]}`] : []);
  const child = spawn("systemd-run", [
    "--user", "--wait", "--pipe", "--collect", `--unit=${unit}`,
    `--working-directory=${process.cwd()}`,
    "--setenv=STACHE_SYSTEMD_LAUNCHED=1",
    ...forwarded,
    "/usr/bin/node",
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
  ], { stdio: "inherit" });

  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
    child.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => stop(signal));
  child.on("error", error => {
    console.error(`Failed to start Stache outside the VS Code Snap sandbox: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} else {

  const executable = process.platform === "win32"
    ? "node_modules\\.bin\\tauri.cmd"
    : "node_modules/.bin/tauri";

  const child = spawn(executable, process.argv.slice(2), {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));

  child.on("error", error => {
    console.error(`Failed to start Tauri: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal)
      process.kill(process.pid, signal);
    else
      process.exitCode = code ?? 1;
  });
}
