//! Notificações do GNOME (org.freedesktop.Notifications) espelhadas no Stache.
//!
//! O Stache não ocupa o nome do serviço: ele só observa as chamadas `Notify`
//! como monitor do barramento de sessão, então o GNOME continua mostrando as
//! suas próprias notificações.

#[cfg(target_os = "linux")]
use std::fs;

use rusqlite::Row;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::tasks::Database;

const KEEP_LAST: i64 = 200;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNotification {
    id: i64,
    app: String,
    summary: String,
    body: String,
    created_at: String,
    icon: Option<String>,
}

fn read(row: &Row) -> rusqlite::Result<SystemNotification> {
    Ok(SystemNotification {
        id: row.get(0)?,
        app: row.get(1)?,
        summary: row.get(2)?,
        body: row.get(3)?,
        created_at: row.get(4)?,
        icon: row.get(5)?,
    })
}

#[tauri::command]
pub fn list_notifications(db: State<Database>) -> Result<Vec<SystemNotification>, String> {
    let connection = db.lock()?;
    let mut statement = connection
        .prepare("SELECT id, app, summary, body, created_at, icon FROM notifications ORDER BY id DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], read)
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn clear_notifications(db: State<Database>) -> Result<(), String> {
    db.lock()?
        .execute("DELETE FROM notifications", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_notification(db: State<Database>, id: i64) -> Result<(), String> {
    db.lock()?
        .execute("DELETE FROM notifications WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn start_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            if let Err(error) = monitor(&app) {
                eprintln!("Stache não conseguiu monitorar as notificações: {error}");
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn start_monitor(_app: AppHandle) {}

#[cfg(target_os = "linux")]
fn monitor(app: &AppHandle) -> Result<(), String> {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    use tauri::{Emitter, Manager};
    use zbus::blocking::{fdo::MonitoringProxy, Connection, MessageIterator};
    use zbus::message::Type;
    use zbus::zvariant::OwnedValue;
    use zbus::MatchRule;

    type Notify = (String, u32, String, String, String, Vec<String>, HashMap<String, OwnedValue>, i32);

    // Uma conexão própria: depois de virar monitor ela não pode mais enviar mensagens.
    let connection = Connection::session().map_err(|error| error.to_string())?;
    let rule = MatchRule::builder()
        .msg_type(Type::MethodCall)
        .interface("org.freedesktop.Notifications")
        .and_then(|builder| builder.member("Notify"))
        .map_err(|error| error.to_string())?
        .build();
    MonitoringProxy::new(&connection)
        .map_err(|error| error.to_string())?
        .become_monitor(&[rule], 0)
        .map_err(|error| error.to_string())?;

    let mut last: Option<(String, String, String, Instant)> = None;
    let mut icons: HashMap<String, Option<String>> = HashMap::new();
    for message in MessageIterator::from(connection) {
        let Ok(message) = message else { continue };
        let Ok(notify) = message.body().deserialize::<Notify>() else { continue };
        let (app_name, _, app_icon, summary, body, _, hints, _) = notify;
        if summary.trim().is_empty() && body.trim().is_empty() {
            continue;
        }
        // Alguns apps reenviam a mesma notificação em sequência.
        if let Some((a, s, b, at)) = &last {
            if *a == app_name && *s == summary && *b == body && at.elapsed() < Duration::from_secs(2) {
                continue;
            }
        }
        last = Some((app_name.clone(), summary.clone(), body.clone(), Instant::now()));

        let icon = icons.entry(format!("{app_name}\u{0}{app_icon}")).or_insert_with(|| resolve_icon(&app_name, &app_icon, &hints)).clone();

        let db = app.state::<Database>();
        let Ok(connection) = db.lock() else { continue };
        let saved = connection
            .execute(
                "INSERT INTO notifications (app, summary, body, icon) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![app_name, summary, body, icon],
            )
            .and_then(|_| {
                let id = connection.last_insert_rowid();
                connection.execute(
                    "DELETE FROM notifications WHERE id <= ?1",
                    [id - KEEP_LAST],
                )?;
                connection.query_row(
                    "SELECT id, app, summary, body, created_at, icon FROM notifications WHERE id = ?1",
                    [id],
                    read,
                )
            });
        drop(connection);
        if let Ok(notification) = saved {
            let _ = app.emit("system-notification", notification);
        }
    }
    Ok(())
}

/// Descobre o ícone do app que enviou a notificação e o devolve como data URL.
#[cfg(target_os = "linux")]
fn resolve_icon(
    app_name: &str,
    app_icon: &str,
    hints: &std::collections::HashMap<String, zbus::zvariant::OwnedValue>,
) -> Option<String> {
    let hint = |key: &str| hints.get(key).and_then(|value| String::try_from(value.clone()).ok());

    let mut candidates: Vec<String> = Vec::new();
    candidates.extend(hint("image-path"));
    if !app_icon.is_empty() {
        candidates.push(app_icon.to_owned());
    }
    if let Some(entry) = hint("desktop-entry") {
        let entry = entry.trim_end_matches(".desktop").to_owned();
        candidates.extend(desktop_icon(&entry));
        candidates.push(entry);
    }
    candidates.extend(desktop_icon(&app_name.to_lowercase().replace(' ', "-")));
    candidates.push(app_name.to_lowercase().replace(' ', "-"));

    candidates
        .iter()
        .find_map(|name| find_icon(name))
        .and_then(|path| icon_data_url(&path))
}

#[cfg(target_os = "linux")]
fn data_dirs() -> Vec<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    vec![
        format!("{home}/.local/share").into(),
        "/usr/share".into(),
        "/usr/local/share".into(),
        "/var/lib/snapd/desktop".into(),
        "/var/lib/flatpak/exports/share".into(),
        format!("{home}/.local/share/flatpak/exports/share").into(),
    ]
}

/// Lê `Icon=` do arquivo .desktop do app.
#[cfg(target_os = "linux")]
fn desktop_icon(entry: &str) -> Option<String> {
    if entry.is_empty() {
        return None;
    }
    data_dirs().iter().find_map(|dir| {
        let text = fs::read_to_string(dir.join("applications").join(format!("{entry}.desktop"))).ok()?;
        text.lines()
            .find_map(|line| line.strip_prefix("Icon="))
            .map(|icon| icon.trim().to_owned())
    })
}

#[cfg(target_os = "linux")]
fn find_icon(name: &str) -> Option<std::path::PathBuf> {
    use std::path::{Path, PathBuf};

    let name = name.trim().trim_start_matches("file://");
    if name.is_empty() {
        return None;
    }
    if name.starts_with('/') {
        return Path::new(name).is_file().then(|| PathBuf::from(name));
    }

    fn walk(dir: &Path, wanted: &[String], depth: u8, best: &mut Option<(u64, PathBuf)>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth > 0 {
                    walk(&path, wanted, depth - 1, best);
                }
            } else if path.file_name().and_then(|file| file.to_str()).is_some_and(|file| wanted.iter().any(|w| w == file)) {
                // Prefere SVG e, depois, o maior PNG.
                let score = if path.extension().is_some_and(|ext| ext == "svg") {
                    u64::MAX
                } else {
                    fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0)
                };
                if best.as_ref().is_none_or(|(current, _)| score > *current) {
                    *best = Some((score, path));
                }
            }
        }
    }

    let wanted = vec![format!("{name}.svg"), format!("{name}.png")];
    let mut best = None;
    for dir in data_dirs() {
        walk(&dir.join("icons"), &wanted, 5, &mut best);
        if best.is_some() {
            break;
        }
    }
    if best.is_none() {
        walk(Path::new("/usr/share/pixmaps"), &wanted, 1, &mut best);
    }
    best.map(|(_, path)| path)
}

#[cfg(target_os = "linux")]
fn icon_data_url(path: &std::path::Path) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    let bytes = fs::read(path).ok().filter(|bytes| !bytes.is_empty() && bytes.len() <= 512 * 1024)?;
    let mime = match path.extension().and_then(|ext| ext.to_str()) {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => return None,
    };
    Some(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}
