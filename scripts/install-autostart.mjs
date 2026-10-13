// Compila o Stache (versão final), instala em ~/.local/bin e liga o início com a sessão do GNOME.
// Uso: npm run install:autostart
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, options = {}) => spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });

console.log("1/3  Compilando a versão final (leva alguns minutos)…");
if (run("node", ["scripts/tauri.mjs", "build", "--no-bundle"]).status !== 0) {
  console.error("A compilação falhou.");
  process.exit(1);
}

const built = join(root, "src-tauri", "target", "release", "stache");
if (!existsSync(built)) {
  console.error(`Não encontrei ${built}.`);
  process.exit(1);
}
const bin = join(homedir(), ".local", "bin");
mkdirSync(bin, { recursive: true });
const installed = join(bin, "stache");
// Copia para um nome temporário e renomeia: não falha se o app instalado estiver em uso.
copyFileSync(built, `${installed}.new`);
spawnSync("mv", ["-f", `${installed}.new`, installed]);
console.log(`2/3  Instalado em ${installed}`);

console.log("3/3  Ligando o início automático…");
if (run(installed, ["--autostart", "enable"]).status !== 0) process.exit(1);
console.log("Pronto. Na próxima vez que você entrar no GNOME o Stache sobe sozinho.");
console.log("Para iniciar agora: systemctl --user start stache.service");
