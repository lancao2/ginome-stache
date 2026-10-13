//! Início automático com a sessão: serviço de usuário do systemd.
//!
//! O serviço sobe junto com o `gnome-session-pre.target`, que o systemd inicia antes do
//! próprio GNOME Shell: é o ponto mais cedo possível, já que nenhum app gráfico existe antes
//! do login. Se a tela ainda não existe quando o Stache inicia, ele sai com erro e o
//! systemd o reinicia a cada segundo, até o shell estar pronto.

use std::{fs, path::PathBuf, process::Command};

use serde::Serialize;

const UNIT: &str = "stache.service";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    /// Falso em desenvolvimento (o app compilado em debug precisa do servidor do Vite).
    available: bool,
    reason: String,
}

fn unit_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/systemd/user").join(UNIT)
}

fn executable() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|error| error.to_string())
}

fn is_development() -> bool {
    cfg!(debug_assertions) || executable().is_ok_and(|path| path.to_string_lossy().contains("/target/debug/"))
}

fn systemctl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("systemctl").arg("--user").args(args).output().map_err(|error| format!("systemctl: {error}"))?;
    if output.status.success() { Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned()) }
    else { Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()) }
}

fn unit_text(exe: &str) -> String {
    format!(
        "[Unit]\n\
         Description=Stache (ilha dinâmica)\n\
         Documentation=file://{exe}\n\
         PartOf=graphical-session.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart=\"{exe}\"\n\
         # Sem tela ainda (o shell não subiu), o app sai com erro e é tentado de novo a cada segundo.\n\
         # \"Sair\" no Stache encerra com sucesso e o serviço não volta.\n\
         Restart=on-failure\n\
         RestartSec=1\n\
         StartLimitIntervalSec=0\n\
         \n\
         [Install]\n\
         WantedBy=gnome-session-pre.target\n"
    )
}

#[tauri::command]
pub fn autostart_status() -> Status {
    // "enabled" vale também para quem foi ligado para todos os usuários pelo pacote .deb; "masked" é o "desligado" desse caso.
    let enabled = systemctl(&["is-enabled", UNIT]).is_ok_and(|state| state == "enabled");
    if is_development() {
        return Status { enabled, available: false, reason: "Disponível só no app instalado (npm run install:autostart). Em desenvolvimento o app depende do servidor do Vite.".to_owned() };
    }
    Status { enabled, available: true, reason: String::new() }
}

#[tauri::command(async)]
pub fn autostart_set(enabled: bool) -> Result<(), String> {
    if enabled {
        if is_development() { return Err("Em desenvolvimento não dá para iniciar com o computador: instale o app com npm run install:autostart.".to_owned()); }
        let exe = executable()?;
        let path = unit_path();
        if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|error| error.to_string())?; }
        // Se o serviço foi "mascarado" ao desligar (link para /dev/null), tira a máscara antes de escrever o arquivo.
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) { let _ = fs::remove_file(&path); }
        fs::write(&path, unit_text(&exe.to_string_lossy())).map_err(|error| error.to_string())?;
        systemctl(&["daemon-reload"])?;
        systemctl(&["enable", UNIT])?;
    } else {
        let _ = systemctl(&["disable", UNIT]);
        let _ = fs::remove_file(unit_path());
        let _ = systemctl(&["daemon-reload"]);
        // Ligado para todos os usuários pelo pacote .deb, o "disable" não basta: mascara só para este usuário.
        if systemctl(&["is-enabled", UNIT]).is_ok_and(|state| state == "enabled") {
            systemctl(&["mask", UNIT])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn unit_has_early_start_and_retry() {
        let text = super::unit_text("/home/a b/stache");
        assert!(text.contains("WantedBy=gnome-session-pre.target"));
        assert!(text.contains("ExecStart=\"/home/a b/stache\""));
        assert!(text.contains("Restart=on-failure") && text.contains("StartLimitIntervalSec=0"));
    }
}

const EXTENSION: &str = "stache-reserved-space@alexlan";
/// Esconde a barra superior do GNOME (o pacote traz uma cópia); o Stache ocupa o topo.
const HIDE_TOP_BAR: &str = "hidetopbar@mathieu.bidon.ca";

fn extension_installed(uuid: &str) -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    ["/usr/share/gnome-shell/extensions", &format!("{home}/.local/share/gnome-shell/extensions")]
        .iter()
        .any(|dir| std::path::Path::new(dir).join(uuid).is_dir())
}

/// Coloca a extensão na lista de ativas do usuário. Devolve true se foi preciso adicioná-la.
fn enable_extension(uuid: &str) -> bool {
    if !extension_installed(uuid) { return false; }
    let Ok(output) = Command::new("gsettings").args(["get", "org.gnome.shell", "enabled-extensions"]).output() else { return false };
    let current = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if current.contains(uuid) { return false; }
    // Formato "['a', 'b']" ou "@as []" (lista vazia).
    let list = current.trim_start_matches("@as ").trim().trim_start_matches('[').trim_end_matches(']').trim();
    let updated = if list.is_empty() { format!("['{uuid}']") } else { format!("[{list}, '{uuid}']") };
    Command::new("gsettings").args(["set", "org.gnome.shell", "enabled-extensions", &updated]).status().is_ok_and(|status| status.success())
}

/// Instalados pelo pacote, as extensões do GNOME ainda precisam estar na lista de ativas do usuário.
/// Melhor esforço: o shell só passa a vê-las depois de sair e entrar na sessão.
pub fn ensure_extension_enabled() {
    enable_extension(EXTENSION);
    // Só na primeira ativação: depois disso as preferências do usuário na extensão são dele.
    if enable_extension(HIDE_TOP_BAR) {
        let schema_dir = ["/usr/share/gnome-shell/extensions", &format!("{}/.local/share/gnome-shell/extensions", std::env::var("HOME").unwrap_or_default())]
            .iter()
            .map(|dir| std::path::Path::new(dir).join(HIDE_TOP_BAR).join("schemas"))
            .find(|dir| dir.is_dir());
        if let Some(dir) = schema_dir {
            for key in ["enable-active-window", "enable-intellihide", "mouse-sensitive"] {
                let _ = Command::new("gsettings")
                    .args(["--schemadir", &dir.to_string_lossy(), "set", "org.gnome.shell.extensions.hidetopbar", key, "false"])
                    .status();
            }
        }
    }
}
