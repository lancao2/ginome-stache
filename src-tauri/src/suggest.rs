//! Sugestões da busca: apps e pastas que o usuário mais abre pelo Stache.
//!
//! Cada app iniciado e cada pasta aberta somam um uso numa tabela do SQLite local. Enquanto
//! o histórico é curto, a lista é completada com os favoritos do GNOME e as pastas pessoais.

use std::{path::PathBuf, process::Command, sync::Arc, time::{SystemTime, UNIX_EPOCH}};

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{apps::{self, AppHit, Apps}, search::Hit, tasks::Database};

const MAX_APPS: usize = 6;
const MAX_DIRS: usize = 5;
const TABLE: &str = "CREATE TABLE IF NOT EXISTS usage (
    kind  TEXT NOT NULL,
    key   TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    last  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, key)
);";

#[derive(Serialize)]
pub struct Suggestions {
    apps: Vec<AppHit>,
    dirs: Vec<Hit>,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs() as i64)
}

/// Soma um uso (`kind`: "app" ou "dir").
pub fn record(app: &AppHandle, kind: &str, key: &str) {
    let Some(db) = app.try_state::<Database>() else { return };
    let Ok(connection) = db.lock() else { return };
    let _ = connection.execute_batch(TABLE);
    let _ = connection.execute(
        "INSERT INTO usage (kind, key, count, last) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(kind, key) DO UPDATE SET count = count + 1, last = ?3",
        params![kind, key, now()],
    );
}

fn most_used(db: &Database, kind: &str, limit: usize) -> Vec<String> {
    let Ok(connection) = db.lock() else { return Vec::new() };
    let _ = connection.execute_batch(TABLE);
    let Ok(mut statement) = connection.prepare("SELECT key FROM usage WHERE kind = ?1 ORDER BY count DESC, last DESC LIMIT ?2") else { return Vec::new() };
    statement
        .query_map(params![kind, limit as i64], |row| row.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn gnome_favorites() -> Vec<String> {
    let Ok(output) = Command::new("gsettings").args(["get", "org.gnome.shell", "favorite-apps"]).output() else { return Vec::new() };
    String::from_utf8_lossy(&output.stdout)
        .split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

fn personal_dirs() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let Ok(text) = std::fs::read_to_string(PathBuf::from(&home).join(".config/user-dirs.dirs")) else { return Vec::new() };
    text.lines()
        .filter(|line| !line.starts_with('#') && !line.contains("DESKTOP") && !line.contains("TEMPLATES") && !line.contains("PUBLICSHARE"))
        .filter_map(|line| line.split_once('=').map(|(_, value)| value.trim().trim_matches('"').replace("$HOME", &home)))
        .filter(|path| path != &home && PathBuf::from(path).is_dir())
        .collect()
}

#[tauri::command(async)]
pub fn search_suggestions(db: State<Database>, apps: State<Arc<Apps>>) -> Suggestions {
    let mut app_ids = most_used(&db, "app", MAX_APPS);
    for id in gnome_favorites() {
        if app_ids.len() >= MAX_APPS { break; }
        if !app_ids.contains(&id) { app_ids.push(id); }
    }
    let mut app_hits = apps::hits_for(&apps, &app_ids);
    app_hits.truncate(MAX_APPS);

    let mut dirs: Vec<String> = most_used(&db, "dir", MAX_DIRS * 2).into_iter().filter(|path| PathBuf::from(path).is_dir()).take(MAX_DIRS).collect();
    for path in personal_dirs() {
        if dirs.len() >= MAX_DIRS { break; }
        if !dirs.contains(&path) { dirs.push(path); }
    }
    let dirs = dirs.into_iter().map(|path| Hit::folder(path)).collect();
    Suggestions { apps: app_hits, dirs }
}
