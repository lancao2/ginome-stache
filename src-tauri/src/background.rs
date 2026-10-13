//! Apps em segundo plano: programas do usuário que estão rodando sem nenhuma janela aberta.
//!
//! O systemd coloca cada app iniciado numa "scope" (`app-gnome-<id>-<pid>.scope`,
//! `snap.<pacote>.<app>-<uuid>.scope`, `app-flatpak-<id>-<n>.scope`); lendo o cgroup de cada
//! processo sabemos a quem ele pertence. As janelas abertas vêm da extensão do GNOME.

use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

use serde::Serialize;
use tauri::State;

use crate::apps::{self, Apps};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundApp {
    id: String,
    name: String,
    icon: String,
    processes: usize,
    memory_mb: u64,
    has_window: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundApps {
    apps: Vec<BackgroundApp>,
    /// Falso quando a extensão não respondeu: aí a lista inclui apps com janela.
    windows_known: bool,
}

/// Id do .desktop a que a scope pertence, ou None se não for um app.
fn desktop_id(scope: &str) -> Option<String> {
    let name = scope.strip_suffix(".scope")?;
    if let Some(rest) = name.strip_prefix("snap.") {
        // snap.<pacote>.<app>-<uuid de 36 caracteres>
        let base = rest.get(..rest.len().checked_sub(37)?)?;
        let (package, app) = base.split_once('.')?;
        return Some(format!("{package}_{app}.desktop"));
    }
    let rest = name.strip_prefix("app-")?;
    // Tira o "-<pid>" final e o nome de quem iniciou ("gnome-", "flatpak-"…).
    let (body, pid) = rest.rsplit_once('-')?;
    if pid.is_empty() || !pid.chars().all(|ch| ch.is_ascii_digit()) { return None; }
    let id = match body.split_once('-') { Some((_, id)) => id, None => body };
    // O systemd escreve "-" e "." dentro de nomes como \x2d e \x2e; só depois de separar as partes.
    (!id.is_empty()).then(|| format!("{}.desktop", id.replace("\\x2d", "-").replace("\\x2e", ".")))
}

/// Nome de entradas de autostart (apps de bandeja e serviços de sessão não ficam em applications/).
fn autostart_name(id: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    [PathBuf::from(home).join(".config/autostart"), PathBuf::from("/etc/xdg/autostart")]
        .iter()
        .find_map(|dir| fs::read_to_string(dir.join(id)).ok())
        .and_then(|text| {
            let lang = std::env::var("LANG").unwrap_or_default();
            let short = lang.split(['.', '_']).next().unwrap_or("").to_owned();
            let mut plain = None;
            for line in text.lines() {
                if let Some(value) = line.strip_prefix(&format!("Name[{short}]=")) { return Some(value.to_owned()); }
                if let Some(value) = line.strip_prefix("Name=") { plain.get_or_insert(value.to_owned()); }
            }
            plain
        })
}

fn pretty(id: &str) -> String {
    let base = id.trim_end_matches(".desktop").rsplit('.').next().unwrap_or(id);
    let mut name = base.replace(['_', '-'], " ");
    if let Some(first) = name.get(..1) { name = first.to_uppercase() + &name[1..]; }
    name
}

fn windows() -> Option<Vec<String>> {
    let connection = zbus::blocking::Connection::session().ok()?;
    let proxy = crate::clipboard::extension::proxy(&connection).ok()?;
    proxy.call_method("RunningApps", &()).ok()?.body().deserialize::<Vec<String>>().ok()
}

#[tauri::command(async)]
pub fn background_apps(apps: State<Arc<Apps>>) -> BackgroundApps {
    // id do .desktop -> (processos, memória em KiB)
    let mut running: HashMap<String, (usize, u64)> = HashMap::new();
    if let Ok(read) = fs::read_dir("/proc") {
        for entry in read.flatten() {
            let pid = entry.file_name();
            let Some(pid) = pid.to_str().filter(|pid| pid.bytes().all(|byte| byte.is_ascii_digit())) else { continue };
            let Ok(cgroup) = fs::read_to_string(format!("/proc/{pid}/cgroup")) else { continue };
            let Some(scope) = cgroup.lines().filter_map(|line| line.rsplit('/').next()).find(|leaf| leaf.ends_with(".scope")) else { continue };
            let Some(id) = desktop_id(scope) else { continue };
            let pages: u64 = fs::read_to_string(format!("/proc/{pid}/statm")).ok()
                .and_then(|text| text.split_whitespace().nth(1).and_then(|rss| rss.parse().ok())).unwrap_or(0);
            let slot = running.entry(id).or_default();
            slot.0 += 1;
            slot.1 += pages * 4;
        }
    }

    let with_windows = windows();
    let mut list: Vec<BackgroundApp> = running
        .into_iter()
        .map(|(id, (processes, kib))| {
            let has_window = with_windows.as_ref().is_some_and(|open| open.contains(&id));
            let (name, icon) = apps::info(&apps, &id)
                .unwrap_or_else(|| (autostart_name(&id).unwrap_or_else(|| pretty(&id)), apps::icon_of(&apps, id.trim_end_matches(".desktop"))));
            BackgroundApp { id, name, icon, processes, memory_mb: kib / 1024, has_window }
        })
        .filter(|app| with_windows.is_none() || !app.has_window)
        .collect();
    list.sort_by(|a, b| b.memory_mb.cmp(&a.memory_mb).then_with(|| a.name.cmp(&b.name)));
    BackgroundApps { apps: list, windows_known: with_windows.is_some() }
}

#[cfg(test)]
mod tests {
    use super::desktop_id;

    #[test]
    fn scopes() {
        assert_eq!(desktop_id("app-gnome-anydesk_global_tray-78435.scope").as_deref(), Some("anydesk_global_tray.desktop"));
        assert_eq!(desktop_id("app-gnome-org.gnome.Evolution\\x2dalarm\\x2dnotify-78419.scope").as_deref(), Some("org.gnome.Evolution-alarm-notify.desktop"));
        assert_eq!(desktop_id("snap.code.code-c0d46352-752c-4191-92fa-0181dc4de9bb.scope").as_deref(), Some("code_code.desktop"));
        assert_eq!(desktop_id("app-flatpak-com.spotify.Client-1234.scope").as_deref(), Some("com.spotify.Client.desktop"));
        assert_eq!(desktop_id("app-firefox-1.scope").as_deref(), Some("firefox.desktop"));
        assert_eq!(desktop_id("session-3.scope"), None);
    }
}
