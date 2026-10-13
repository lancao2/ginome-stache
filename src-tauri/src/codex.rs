//! Ponte com o Codex: roda `codex app-server` (JSON por linha em stdin/stdout) e
//! repassa as linhas à interface, que fala o protocolo. Aqui não há lógica de chat.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Bridge {
    inner: Mutex<Option<(Child, ChildStdin)>>,
}

fn emit_local(app: &AppHandle, event: Value) {
    let _ = app.emit("codex-event", event);
}

/// Inicia o app-server (não faz nada se já estiver rodando).
#[tauri::command]
pub fn codex_start(app: AppHandle, bridge: State<Bridge>) -> Result<(), String> {
    let mut guard = bridge.inner.lock().map_err(|error| error.to_string())?;
    if let Some((child, _)) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    let mut child = match Command::new("codex")
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            emit_local(&app, json!({ "method": "stache/unavailable", "params": { "message": "Codex CLI não encontrado no PATH." } }));
            return Err(error.to_string());
        }
    };
    let stdin = child.stdin.take().ok_or("stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("stdout unavailable")?;

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                let _ = handle.emit("codex-event", message);
            }
        }
        emit_local(&handle, json!({ "method": "stache/stopped" }));
    });

    *guard = Some((child, stdin));
    Ok(())
}

/// Escreve uma mensagem JSON (pedido, resposta ou notificação) no app-server.
#[tauri::command]
pub fn codex_send(bridge: State<Bridge>, message: Value) -> Result<(), String> {
    let mut guard = bridge.inner.lock().map_err(|error| error.to_string())?;
    let (_, stdin) = guard.as_mut().ok_or("Codex não está iniciado.")?;
    let mut line = message.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|error| error.to_string())
}

/// Abre o seletor de pastas do sistema (zenity) e devolve o caminho escolhido.
#[tauri::command]
pub async fn pick_folder(start: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("zenity");
        command.args(["--file-selection", "--directory", "--title=Pasta do Codex"]);
        if let Some(path) = start.filter(|path| !path.is_empty()) {
            command.arg(format!("--filename={}/", path.trim_end_matches('/')));
        }
        let output = command.stderr(Stdio::null()).output().map_err(|error| error.to_string())?;
        // Código 1 = cancelado.
        if !output.status.success() {
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        Ok((!path.is_empty()).then_some(path))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Encerra o app-server junto com o app.
pub fn stop(app: &AppHandle) {
    use tauri::Manager;
    if let Some(bridge) = app.try_state::<Bridge>() {
        if let Ok(mut guard) = bridge.inner.lock() {
            if let Some((mut child, _)) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}
