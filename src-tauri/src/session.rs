//! Estado da sessão do GNOME: o Stache só aparece com a tela desbloqueada.
//!
//! O app pode ser iniciado antes do desbloqueio (é um serviço do usuário que sobe com a
//! sessão). Enquanto a tela está bloqueada a janela fica escondida e as tarefas que poderiam
//! pedir a senha do cofre (Keyring) esperam; ao desbloquear, tudo continua.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use tauri::AppHandle;

static LOCKED: AtomicBool = AtomicBool::new(false);
/// A interface já pediu para a janela aparecer (ela só aparece depois de carregar).
static WANT_VISIBLE: AtomicBool = AtomicBool::new(false);

pub fn locked() -> bool { LOCKED.load(Ordering::Relaxed) }

/// Bloqueia a thread até a tela ser desbloqueada.
pub fn wait_unlocked() {
    while locked() { thread::sleep(Duration::from_secs(1)); }
}

/// Registra se a janela deve estar visível; devolve se ela pode aparecer agora.
pub fn set_wanted(visible: bool) -> bool {
    WANT_VISIBLE.store(visible, Ordering::Relaxed);
    visible && !locked()
}

#[cfg(target_os = "linux")]
fn apply(app: &AppHandle) {
    let show = WANT_VISIBLE.load(Ordering::Relaxed) && !locked();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if show { let _ = crate::show_island(&handle); } else { crate::hide_island(&handle); }
    });
}

/// Acompanha o bloqueio de tela (org.gnome.ScreenSaver) e reconecta se o shell reiniciar.
#[cfg(target_os = "linux")]
pub fn start(app: AppHandle) {
    thread::spawn(move || loop {
        if let Ok(connection) = zbus::blocking::Connection::session() {
            if let Ok(proxy) = zbus::blocking::Proxy::new(&connection, "org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver") {
                let update = |active: bool| {
                    if LOCKED.swap(active, Ordering::Relaxed) != active { apply(&app); }
                };
                if let Some(active) = proxy.call_method("GetActive", &()).ok().and_then(|reply| reply.body().deserialize::<bool>().ok()) { update(active); }
                if let Ok(signals) = proxy.receive_signal("ActiveChanged") {
                    for message in signals {
                        if let Ok(active) = message.body().deserialize::<bool>() { update(active); }
                    }
                }
            }
        }
        thread::sleep(Duration::from_secs(5));
    });
}

#[cfg(not(target_os = "linux"))]
pub fn start(_app: AppHandle) {}
