//! Ponte com o WhatsApp: um processo Node (sidecar/whatsapp) fala o protocolo
//! do WhatsApp Web; aqui só repassamos linhas JSON nos dois sentidos.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct Bridge {
    inner: Mutex<Option<(Child, ChildStdin)>>,
}

fn script_path() -> Option<PathBuf> {
    // Em desenvolvimento o sidecar fica ao lado do código; instalado, junto do executável.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/whatsapp/index.mjs");
    let beside = std::env::current_exe().ok()?.parent()?.join("sidecar/whatsapp/index.mjs");
    // Instalado pelo pacote .deb.
    let packaged = PathBuf::from("/usr/lib/stache/sidecar/whatsapp/index.mjs");
    [dev, beside, packaged].into_iter().find(|path| path.exists())
}

fn emit_status(app: &AppHandle, state: &str, message: &str) {
    let _ = app.emit("whatsapp-event", json!({ "type": "status", "state": state, "message": message }));
}

/// Inicia a ponte (não faz nada se já estiver rodando).
#[tauri::command]
pub fn whatsapp_start(app: AppHandle, bridge: State<Bridge>) -> Result<(), String> {
    let mut guard = bridge.inner.lock().map_err(|error| error.to_string())?;
    if let Some((child, _)) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            // Já rodando (a interface recarregou): pede o estado atual de novo.
            if let Some((_, stdin)) = guard.as_mut() {
                let _ = stdin.write_all(b"{\"cmd\":\"status\"}\n").and_then(|_| stdin.flush());
            }
            return Ok(());
        }
    }
    let Some(script) = script_path() else {
        emit_status(&app, "unavailable", "Sidecar do WhatsApp não encontrado.");
        return Err("sidecar not found".into());
    };
    if !script.parent().is_some_and(|dir| dir.join("node_modules").exists()) {
        emit_status(&app, "unavailable", "Falta instalar as dependências: npm install em sidecar/whatsapp.");
        return Err("sidecar dependencies missing".into());
    }
    let auth = app.path().app_data_dir().map_err(|error| error.to_string())?.join("whatsapp-auth");

    let mut child = match Command::new("node")
        .arg(&script)
        .arg(&auth)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            emit_status(&app, "unavailable", "Node.js não encontrado no sistema.");
            return Err(error.to_string());
        }
    };
    let stdin = child.stdin.take().ok_or("stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("stdout unavailable")?;

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                let _ = handle.emit("whatsapp-event", event);
            }
        }
        // O processo terminou: avisa a interface para poder reconectar.
        emit_status(&handle, "stopped", "");
    });

    *guard = Some((child, stdin));
    Ok(())
}

/// Envia um comando JSON ao sidecar (send_text, send_audio, logout).
#[tauri::command]
pub fn whatsapp_send(bridge: State<Bridge>, command: Value) -> Result<(), String> {
    let mut guard = bridge.inner.lock().map_err(|error| error.to_string())?;
    let (_, stdin) = guard.as_mut().ok_or("WhatsApp não está conectado.")?;
    let mut line = command.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|error| error.to_string())
}

/// Encerra o sidecar junto com o app.
pub fn stop(app: &AppHandle) {
    if let Some(bridge) = app.try_state::<Bridge>() {
        if let Ok(mut guard) = bridge.inner.lock() {
            if let Some((mut child, _)) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}
