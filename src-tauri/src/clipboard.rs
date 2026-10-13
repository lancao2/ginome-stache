//! Histórico da área de transferência. Quem observa o que você copia, ouve o Super+V e
//! cola é a extensão do GNOME (o Wayland não permite isso a um app comum); aqui só
//! guardamos o histórico: 24 horas, a menos que o item seja favoritado.

use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Row};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::tasks::Database;

const KEEP: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_UNPINNED: i64 = 300;
const MAX_CHARS: usize = 50_000;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const IMAGES_DIR: &str = "clipboard-images";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    id: i64,
    text: String,
    created_at: i64,
    favorite: bool,
    /// "text" ou "image"; nas imagens, `text` é só uma chave interna.
    kind: &'static str,
    /// Caminho do PNG guardado, para imagens.
    image: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read(row: &Row) -> rusqlite::Result<ClipItem> {
    let image: Option<String> = row.get(4)?;
    Ok(ClipItem {
        id: row.get(0)?,
        text: row.get(1)?,
        created_at: row.get(2)?,
        favorite: row.get::<_, i64>(3)? != 0,
        kind: if image.is_some() { "image" } else { "text" },
        image,
    })
}

fn purge(connection: &rusqlite::Connection) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM clipboard WHERE favorite = 0 AND created_at < ?1", params![now_ms() - KEEP.as_millis() as i64])?;
    connection.execute(
        "DELETE FROM clipboard WHERE favorite = 0 AND id NOT IN
         (SELECT id FROM clipboard WHERE favorite = 0 ORDER BY created_at DESC LIMIT ?1)",
        params![MAX_UNPINNED],
    )?;
    Ok(())
}

fn remember(app: &AppHandle, text: String) {
    if text.trim().is_empty() || text.chars().count() > MAX_CHARS {
        return;
    }
    let Some(db) = app.try_state::<Database>() else { return };
    let Ok(connection) = db.lock() else { return };
    let saved = connection
        .execute(
            "INSERT INTO clipboard (text, created_at, favorite) VALUES (?1, ?2, 0)
             ON CONFLICT(text) DO UPDATE SET created_at = excluded.created_at",
            params![text, now_ms()],
        )
        .and_then(|_| purge(&connection));
    drop(connection);
    if saved.is_ok() {
        let _ = app.emit("clipboard-updated", ());
    }
}

fn images_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(IMAGES_DIR))
}

/// Apaga os PNG que nenhum item do histórico usa mais (itens que expiraram ou foram apagados).
fn sweep_images(dir: &Path, connection: &rusqlite::Connection) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let Ok(mut statement) = connection.prepare("SELECT image_path FROM clipboard WHERE image_path IS NOT NULL") else { return };
    let used: std::collections::HashSet<String> = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default();
    for entry in read.flatten() {
        let path = entry.path();
        if path.to_str().is_some_and(|text| !used.contains(text)) { let _ = fs::remove_file(path); }
    }
}

/// Guarda um print/imagem copiado: o arquivo vem da extensão; aqui ele ganha um nome pelo
/// conteúdo (a mesma imagem copiada duas vezes vira um item só).
fn remember_image(app: &AppHandle, incoming: String) {
    let incoming = PathBuf::from(incoming);
    let Some(dir) = images_dir(app) else { return };
    let stored = (|| {
        if fs::metadata(&incoming).ok()?.len() > MAX_IMAGE_BYTES { return None; }
        let bytes = fs::read(&incoming).ok()?;
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        let key = format!("{:016x}-{}", hasher.finish(), bytes.len());
        fs::create_dir_all(&dir).ok()?;
        Some((dir.join(format!("{key}.png")), key))
    })();
    let Some((target, key)) = stored else { let _ = fs::remove_file(&incoming); return };
    let Some(db) = app.try_state::<Database>() else { return };
    let Ok(connection) = db.lock() else { return };
    if !target.exists() { let _ = fs::rename(&incoming, &target); } else { let _ = fs::remove_file(&incoming); }
    let Some(path) = target.to_str() else { return };
    let saved = connection
        .execute(
            "INSERT INTO clipboard (text, created_at, favorite, image_path) VALUES (?1, ?2, 0, ?3)
             ON CONFLICT(text) DO UPDATE SET created_at = excluded.created_at",
            params![format!("image:{key}"), now_ms(), path],
        )
        .and_then(|_| purge(&connection));
    sweep_images(&dir, &connection);
    drop(connection);
    if saved.is_ok() {
        let _ = app.emit("clipboard-updated", ());
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod extension {
    use std::{thread, time::Duration};

    use tauri::{AppHandle, Emitter};
    use zbus::blocking::{Connection, Proxy};

    pub const NAME: &str = "org.gnome.Shell.Extensions.Stache";
    pub const PATH: &str = "/org/gnome/Shell/Extensions/Stache";

    pub fn proxy(connection: &Connection) -> zbus::Result<Proxy<'_>> {
        Proxy::new(connection, NAME, PATH, NAME)
    }

    /// Escuta um sinal da extensão para sempre; se o Shell reiniciar, reconecta.
    pub fn listen(app: AppHandle, signal: &'static str, on_message: impl Fn(&AppHandle, zbus::message::Message) + Send + 'static) {
        thread::spawn(move || loop {
            if let Ok(connection) = Connection::session() {
                if let Ok(proxy) = proxy(&connection) {
                    if let Ok(messages) = proxy.receive_signal(signal) {
                        for message in messages {
                            on_message(&app, message);
                        }
                    }
                }
            }
            thread::sleep(Duration::from_secs(5));
        });
    }

    pub fn call_paste(text: &str) -> Result<(), String> {
        let connection = Connection::session().map_err(|error| error.to_string())?;
        proxy(&connection)
            .and_then(|proxy| proxy.call_method("Paste", &(text,)))
            .map(|_| ())
            .map_err(|error| format!("A extensão do Stache não respondeu ({error}). Ative-a e reinicie a sessão."))
    }

    pub fn call_paste_image(path: &str) -> Result<(), String> {
        let connection = Connection::session().map_err(|error| error.to_string())?;
        proxy(&connection)
            .and_then(|proxy| proxy.call_method("PasteImage", &(path,)))
            .map(|_| ())
            .map_err(|error| format!("A extensão do Stache não respondeu ({error}). Reinicie a sessão para ativar o suporte a imagens."))
    }

    pub fn shortcut(app: &AppHandle) {
        let _ = app.emit("clipboard-shortcut", ());
    }
}

/// Cria a tabela e começa a ouvir a extensão.
pub fn start(app: AppHandle) {
    if let Some(db) = app.try_state::<Database>() {
        if let Ok(connection) = db.lock() {
            let _ = connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS clipboard (
                     id         INTEGER PRIMARY KEY AUTOINCREMENT,
                     text       TEXT NOT NULL UNIQUE,
                     created_at INTEGER NOT NULL,
                     favorite   INTEGER NOT NULL DEFAULT 0
                 );",
            );
            // Imagens: coluna acrescentada depois; o erro de "já existe" é esperado.
            let _ = connection.execute("ALTER TABLE clipboard ADD COLUMN image_path TEXT", []);
            let _ = purge(&connection);
            if let Some(dir) = images_dir(&app) { sweep_images(&dir, &connection); }
        }
    }
    #[cfg(target_os = "linux")]
    {
        extension::listen(app.clone(), "ClipboardChanged", |app, message| {
            if let Ok(text) = message.body().deserialize::<String>() {
                remember(app, text);
            }
        });
        extension::listen(app.clone(), "ClipboardImage", |app, message| {
            if let Ok(path) = message.body().deserialize::<String>() {
                remember_image(app, path);
            }
        });
        extension::listen(app, "ClipboardShortcut", |app, _| extension::shortcut(app));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

#[tauri::command]
pub fn clipboard_list(db: State<Database>) -> Result<Vec<ClipItem>, String> {
    let connection = db.lock()?;
    purge(&connection).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id, text, created_at, favorite, image_path FROM clipboard ORDER BY favorite DESC, created_at DESC")
        .map_err(|error| error.to_string())?;
    statement
        .query_map([], read)
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clipboard_toggle_favorite(db: State<Database>, id: i64) -> Result<(), String> {
    db.lock()?
        .execute("UPDATE clipboard SET favorite = 1 - favorite WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clipboard_delete(app: AppHandle, db: State<Database>, id: i64) -> Result<(), String> {
    let connection = db.lock()?;
    connection.execute("DELETE FROM clipboard WHERE id = ?1", params![id]).map_err(|error| error.to_string())?;
    if let Some(dir) = images_dir(&app) { sweep_images(&dir, &connection); }
    Ok(())
}

/// Apaga tudo, menos os favoritos.
#[tauri::command]
pub fn clipboard_clear(app: AppHandle, db: State<Database>) -> Result<(), String> {
    let connection = db.lock()?;
    connection.execute("DELETE FROM clipboard WHERE favorite = 0", []).map_err(|error| error.to_string())?;
    if let Some(dir) = images_dir(&app) { sweep_images(&dir, &connection); }
    Ok(())
}

/// Coloca o item na área de transferência e cola na janela que tinha o foco.
#[tauri::command]
pub fn clipboard_paste(db: State<Database>, id: i64) -> Result<(), String> {
    let (text, image): (String, Option<String>) = db
        .lock()?
        .query_row("SELECT text, image_path FROM clipboard WHERE id = ?1", params![id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    return match image {
        Some(path) => extension::call_paste_image(&path),
        None => extension::call_paste(&text),
    };
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (text, image);
        Err("Colar só está disponível no GNOME.".to_owned())
    }
}

/// Pede à extensão que dê o foco do teclado à ilha (setas e Enter).
#[tauri::command]
pub fn clipboard_focus(app: AppHandle) {
    // Além da janela (extensão), o próprio webview precisa receber o foco do teclado.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
    #[cfg(target_os = "linux")]
    if let Ok(connection) = zbus::blocking::Connection::session() {
        if let Ok(proxy) = extension::proxy(&connection) {
            let _ = proxy.call_method("FocusIsland", &());
        }
    }
}
