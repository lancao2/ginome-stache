//! Cofre de credenciais do Stache: GNOME Keyring (Secret Service, `org.freedesktop.secrets`).
//!
//! Segredos próprios do Stache (links secretos de agendas, opções secretas de plugins) ficam
//! no Keyring, cifrados e destravados com o login, e não em texto puro no banco. Se o
//! Keyring não estiver disponível (sessão sem GNOME, cofre que não destrava), o segredo vai
//! para um arquivo com permissão 0600 e a interface mostra um aviso. Quem lê segredos usa
//! só `get`: o Keyring tem prioridade, o arquivo é o plano B.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

use oo7::Keyring;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Quanto esperar o Keyring (inclui o pedido de senha de um cofre trancado).
const WAIT: Duration = Duration::from_secs(25);

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Keyring,
    File,
}

static LAST_BACKEND: Mutex<Option<Backend>> = Mutex::new(None);

fn remember(backend: Backend) { if let Ok(mut last) = LAST_BACKEND.lock() { *last = Some(backend); } }

fn attributes(kind: &str, id: &str) -> HashMap<String, String> {
    HashMap::from([("app".to_owned(), "stache".to_owned()), ("kind".to_owned(), kind.to_owned()), ("id".to_owned(), id.to_owned())])
}

/// Conexão com o Keyring, reaproveitada: a troca de chaves da sessão é a parte lenta.
static HANDLE: Mutex<Option<Arc<Keyring>>> = Mutex::new(None);

async fn unlocked() -> Result<Arc<Keyring>, oo7::Error> {
    let cached = HANDLE.lock().ok().and_then(|slot| slot.clone());
    let keyring = match cached {
        Some(keyring) => keyring,
        None => {
            let fresh = Arc::new(Keyring::new().await?);
            if let Ok(mut slot) = HANDLE.lock() { *slot = Some(fresh.clone()); }
            fresh
        }
    };
    if keyring.is_locked().await? { keyring.unlock().await?; }
    Ok(keyring)
}

/// Roda uma operação do Keyring numa thread, com limite de tempo.
fn blocking<T: Send + 'static>(work: impl std::future::Future<Output = Result<T, oo7::Error>> + Send + 'static) -> Result<T, String> {
    // Com a tela bloqueada o Keyring pode estar trancado: não abre pedido de senha por baixo do bloqueio.
    if crate::session::locked() { return Err("a tela está bloqueada".to_owned()); }
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || { let _ = sender.send(pollster::block_on(work).map_err(|error| error.to_string())); });
    let outcome = receiver.recv_timeout(WAIT).map_err(|_| "o Keyring não respondeu a tempo".to_owned()).and_then(|result| result);
    // Se algo falhou, a conexão pode estar velha (Keyring reiniciado): a próxima operação reconecta.
    if outcome.is_err() { if let Ok(mut slot) = HANDLE.lock() { *slot = None; } }
    outcome
}

fn keyring_set(kind: &str, id: &str, secret: &str) -> Result<(), String> {
    let (attrs, label, secret) = (attributes(kind, id), format!("Stache · {kind}"), secret.to_owned());
    blocking(async move {
        let keyring = unlocked().await?;
        keyring.create_item(&label, &attrs, secret.as_str(), true).await
    })
}

fn keyring_get(kind: &str, id: &str) -> Result<Option<String>, String> {
    let attrs = attributes(kind, id);
    blocking(async move {
        let keyring = unlocked().await?;
        let Some(item) = keyring.search_items(&attrs).await?.into_iter().next() else { return Ok(None) };
        let secret = item.secret().await?;
        Ok(Some(String::from_utf8_lossy(secret.as_bytes()).into_owned()))
    })
}

fn keyring_delete(kind: &str, id: &str) -> Result<(), String> {
    let attrs = attributes(kind, id);
    blocking(async move {
        let keyring = unlocked().await?;
        keyring.delete(&attrs).await
    })
}

// --- Plano B: arquivo 0600 -------------------------------------------------------------

fn file_path(app: &AppHandle) -> PathBuf { app.path().app_data_dir().unwrap_or_default().join("vault-fallback.json") }

fn file_read(app: &AppHandle) -> HashMap<String, String> {
    fs::read_to_string(file_path(app)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn file_write(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let path = file_path(app);
    if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|error| error.to_string())?; }
    if map.is_empty() { let _ = fs::remove_file(&path); return Ok(()); }
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path).map_err(|error| error.to_string())?;
    // Garante 0600 mesmo se o arquivo já existia com outra permissão.
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
    file.write_all(serde_json::to_string(map).map_err(|error| error.to_string())?.as_bytes()).map_err(|error| error.to_string())
}

fn slot(kind: &str, id: &str) -> String { format!("{kind}/{id}") }

// --- Interface pública -----------------------------------------------------------------

/// Guarda um segredo; devolve onde ele ficou (Keyring ou arquivo).
pub fn set(app: &AppHandle, kind: &str, id: &str, secret: &str) -> Result<Backend, String> {
    match keyring_set(kind, id, secret) {
        Ok(()) => {
            remember(Backend::Keyring);
            // O que sobrou de uma gravação anterior em arquivo não deve ficar para trás.
            let mut map = file_read(app);
            if map.remove(&slot(kind, id)).is_some() { let _ = file_write(app, &map); }
            Ok(Backend::Keyring)
        }
        Err(_) => {
            let mut map = file_read(app);
            map.insert(slot(kind, id), secret.to_owned());
            file_write(app, &map)?;
            remember(Backend::File);
            Ok(Backend::File)
        }
    }
}

/// Lê um segredo: Keyring primeiro, arquivo depois.
pub fn get(app: &AppHandle, kind: &str, id: &str) -> Option<String> {
    if let Ok(found) = keyring_get(kind, id) {
        remember(Backend::Keyring);
        if found.is_some() { return found; }
    }
    file_read(app).remove(&slot(kind, id))
}

pub fn delete(app: &AppHandle, kind: &str, id: &str) {
    let _ = keyring_delete(kind, id);
    let mut map = file_read(app);
    if map.remove(&slot(kind, id)).is_some() { let _ = file_write(app, &map); }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    backend: Backend,
    /// Quantos segredos estão em arquivo (e não no Keyring).
    in_file: usize,
    message: String,
}

/// Verifica se o Keyring responde e quantos segredos ainda estão no plano B.
#[tauri::command(async)]
pub fn vault_status(app: AppHandle) -> Status {
    let available = blocking(async { unlocked().await.map(|_| ()) }).is_ok();
    let in_file = file_read(&app).len();
    if available { remember(Backend::Keyring); } else { remember(Backend::File); }
    let message = match (available, in_file) {
        (true, 0) => "Segredos protegidos pelo GNOME Keyring.".to_owned(),
        (true, count) => format!("{count} segredo(s) ainda estão em arquivo e passarão ao Keyring na próxima gravação."),
        (false, _) => "O GNOME Keyring não está disponível: os segredos ficam num arquivo só seu (permissão 0600), sem cifra.".to_owned(),
    };
    Status { backend: if available { Backend::Keyring } else { Backend::File }, in_file, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn keyring_round_trip() {
        keyring_set("teste", "abc", "segredo-123").expect("gravar");
        assert_eq!(keyring_get("teste", "abc").expect("ler").as_deref(), Some("segredo-123"));
        keyring_set("teste", "abc", "novo").expect("substituir");
        assert_eq!(keyring_get("teste", "abc").unwrap().as_deref(), Some("novo"));
        keyring_delete("teste", "abc").expect("apagar");
        assert_eq!(keyring_get("teste", "abc").unwrap(), None);
    }
}
