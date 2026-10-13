//! Posição do mouse para os olhos dos mascotes. No Wayland o app só enxerga o mouse sobre a própria
//! janela; quem enxerga a tela toda é a extensão do GNOME, que devolve o ponteiro já relativo ao
//! canto da janela da ilha. Sem a extensão (ou com uma versão antiga) o comando devolve `None`.

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::Mutex;

    use zbus::blocking::Connection;

    use crate::clipboard::extension::{NAME, PATH};

    /// A conexão é reaproveitada: o comando é chamado várias vezes por segundo.
    static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);

    pub fn read() -> Option<(i32, i32)> {
        let mut guard = CONNECTION.lock().ok()?;
        if guard.is_none() {
            *guard = Connection::session().ok();
        }
        let reply = match guard.as_ref()?.call_method(Some(NAME), PATH, Some(NAME), "GetPointer", &()) {
            Ok(reply) => reply,
            Err(_) => {
                // Shell reiniciado ou extensão desativada: a próxima chamada reconecta.
                *guard = None;
                return None;
            }
        };
        let (found, x, y) = reply.body().deserialize::<(bool, i32, i32)>().ok()?;
        found.then_some((x, y))
    }
}

/// Mouse em pixels lógicos, relativo ao canto superior esquerdo da janela da ilha.
#[tauri::command]
pub async fn pointer_position() -> Option<(i32, i32)> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(linux::read).await.ok().flatten()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}
