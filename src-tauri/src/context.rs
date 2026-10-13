//! Eventos contextuais da cápsula: downloads, arquivos copiados, microfone/câmera em uso,
//! Bluetooth e bateria. Cada observador roda numa thread própria, com intervalo longo e
//! prioridade baixa, e envia `context-event` para a interface mostrar na cápsula fechada.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEvent {
    /// Identifica o tipo (e o ícone) do aviso.
    kind: &'static str,
    label: String,
    text: String,
    /// "normal", "success", "warning", "mic", "camera" ou "screen" (as três últimas têm a cor da pílula).
    tone: &'static str,
    /// O que o clique faz: "reveal" (abre a pasta de `path`), "controls" ou "none".
    action: &'static str,
    path: Option<String>,
}

fn send(app: &AppHandle, event: ContextEvent) {
    let _ = app.emit("context-event", event);
}

fn event(kind: &'static str, label: &str, text: String, tone: &'static str, action: &'static str, path: Option<String>) -> ContextEvent {
    ContextEvent { kind, label: label.to_owned(), text, tone, action, path }
}

fn low_priority() {
    #[cfg(target_os = "linux")]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, 10);
    }
}

fn every(period: Duration, mut tick: impl FnMut() + Send + 'static) {
    thread::spawn(move || {
        low_priority();
        loop {
            tick();
            thread::sleep(period);
        }
    });
}

// --- Downloads -------------------------------------------------------------------------

const PARTIAL: &[&str] = &[".part", ".crdownload", ".download", ".opdownload"];

fn downloads_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    let configured = fs::read_to_string(Path::new(&home).join(".config/user-dirs.dirs")).ok().and_then(|text| {
        text.lines()
            .find(|line| line.starts_with("XDG_DOWNLOAD_DIR"))
            .and_then(|line| line.split_once('=').map(|(_, value)| value.trim().trim_matches('"').replace("$HOME", &home)))
    });
    PathBuf::from(configured.unwrap_or_else(|| format!("{home}/Downloads")))
}

fn partial_downloads(dir: &Path) -> HashMap<String, String> {
    let mut found = HashMap::new();
    let Ok(read) = fs::read_dir(dir) else { return found };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(suffix) = PARTIAL.iter().find(|suffix| name.ends_with(*suffix)) {
            found.insert(name.clone(), name[..name.len() - suffix.len()].to_owned());
        }
    }
    found
}

fn watch_downloads(app: AppHandle) {
    let dir = downloads_dir();
    let mut known: HashMap<String, String> = partial_downloads(&dir);
    every(Duration::from_millis(1500), move || {
        let now = partial_downloads(&dir);
        for (partial, name) in &now {
            if !known.contains_key(partial) {
                send(&app, event("download", "Baixando", name.clone(), "normal", "reveal", Some(dir.join(partial).to_string_lossy().into_owned())));
            }
        }
        for (partial, name) in &known {
            // Sumiu o arquivo parcial e existe o final: o download terminou.
            let done = dir.join(name);
            if !now.contains_key(partial) && done.is_file() {
                send(&app, event("download-done", "Download concluído", name.clone(), "success", "reveal", Some(done.to_string_lossy().into_owned())));
            }
        }
        known = now;
    });
}

// --- Microfone e câmera ----------------------------------------------------------------

/// Quem está capturando agora, pelo PipeWire: (microfone, câmera, tela) -> apps.
/// Uma captura de vídeo é "câmera" se a fonte é um dispositivo (v4l2/libcamera); se a fonte
/// é outro programa (o GNOME Shell no compartilhamento de tela), é "tela".
fn pipewire_capture() -> Option<(HashSet<String>, HashSet<String>, HashSet<String>)> {
    let output = Command::new("pw-dump").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let objects: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let objects = objects.as_array()?;
    let is_device = |props: &serde_json::Value| {
        props.as_object().is_some_and(|map| {
            map.keys().any(|key| key.starts_with("api.v4l2") || key.starts_with("api.libcamera"))
                || matches!(props["device.api"].as_str(), Some("v4l2" | "libcamera"))
        })
    };
    // id do nó de origem -> dispositivo físico? (pelos links entre nós)
    let node_props: HashMap<u64, &serde_json::Value> = objects.iter()
        .filter(|object| object["type"] == "PipeWire:Interface:Node")
        .filter_map(|object| Some((object["id"].as_u64()?, &object["info"]["props"])))
        .collect();
    let mut source_of: HashMap<u64, Vec<u64>> = HashMap::new();
    for object in objects.iter().filter(|object| object["type"] == "PipeWire:Interface:Link") {
        if let (Some(from), Some(to)) = (object["info"]["output-node-id"].as_u64(), object["info"]["input-node-id"].as_u64()) {
            source_of.entry(to).or_default().push(from);
        }
    }
    let (mut mic, mut camera, mut screen) = (HashSet::new(), HashSet::new(), HashSet::new());
    for object in objects.iter().filter(|object| object["type"] == "PipeWire:Interface:Node") {
        let info = &object["info"];
        if info["state"] != "running" { continue; }
        let props = &info["props"];
        let name = props["application.name"].as_str().or_else(|| props["node.name"].as_str()).unwrap_or("Um app").to_owned();
        match props["media.class"].as_str() {
            Some("Stream/Input/Audio") => { mic.insert(name); }
            Some("Stream/Input/Video") => {
                let sources = object["id"].as_u64().and_then(|id| source_of.get(&id));
                let from_device = sources.is_none_or(|ids| ids.iter().any(|id| node_props.get(id).is_some_and(|props| is_device(props))));
                if from_device { camera.insert(name); } else { screen.insert(name); }
            }
            _ => {}
        }
    }
    Some((mic, camera, screen))
}

/// Processos com /dev/video* aberto (apps que usam a câmera direto, sem o PipeWire).
fn v4l2_users() -> HashSet<String> {
    let mut apps = HashSet::new();
    let Ok(read) = fs::read_dir("/proc") else { return apps };
    for entry in read.flatten() {
        let pid = entry.file_name();
        let Some(pid) = pid.to_str().filter(|pid| pid.bytes().all(|byte| byte.is_ascii_digit())) else { continue };
        let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
        let uses_camera = fds.flatten().any(|fd| fs::read_link(fd.path()).is_ok_and(|target| target.to_string_lossy().starts_with("/dev/video")));
        if uses_camera {
            let name = fs::read_to_string(format!("/proc/{pid}/comm")).map(|text| text.trim().to_owned()).unwrap_or_else(|_| "Um app".to_owned());
            apps.insert(name);
        }
    }
    apps
}

/// Quem usa microfone e câmera agora; a interface mostra os indicadores fixos na cápsula.
#[derive(Clone, Default, Serialize)]
pub struct CaptureState {
    mic: Vec<String>,
    camera: Vec<String>,
    screen: Vec<String>,
}

fn capture_slot() -> &'static std::sync::Mutex<CaptureState> {
    static SLOT: std::sync::OnceLock<std::sync::Mutex<CaptureState>> = std::sync::OnceLock::new();
    SLOT.get_or_init(Default::default)
}

#[tauri::command]
pub fn capture_state() -> CaptureState {
    capture_slot().lock().map(|state| state.clone()).unwrap_or_default()
}

fn watch_capture(app: AppHandle) {
    let (mut was_mic, mut was_camera, mut was_screen): (HashSet<String>, HashSet<String>, HashSet<String>) = Default::default();
    every(Duration::from_secs(2), move || {
        let (mic, mut camera, screen) = pipewire_capture().unwrap_or_default();
        camera.extend(v4l2_users());
        for name in mic.difference(&was_mic) {
            send(&app, event("mic", "Microfone em uso", name.clone(), "mic", "controls", None));
        }
        for name in camera.difference(&was_camera) {
            send(&app, event("camera", "Câmera em uso", name.clone(), "camera", "controls", None));
        }
        for name in screen.difference(&was_screen) {
            send(&app, event("screen", "Compartilhando a tela", name.clone(), "screen", "controls", None));
        }
        if mic != was_mic || camera != was_camera || screen != was_screen {
            let mut state = CaptureState { mic: mic.iter().cloned().collect(), camera: camera.iter().cloned().collect(), screen: screen.iter().cloned().collect() };
            state.mic.sort();
            state.camera.sort();
            state.screen.sort();
            if let Ok(mut slot) = capture_slot().lock() { *slot = state.clone(); }
            let _ = app.emit("capture-state", state);
        }
        was_mic = mic;
        was_camera = camera;
        was_screen = screen;
    });
}

// --- Bluetooth -------------------------------------------------------------------------

fn bluetooth_connected() -> Option<HashMap<String, String>> {
    let output = Command::new("bluetoothctl").args(["devices", "Connected"]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    if !output.status.success() { return None; }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix("Device "))
            .filter_map(|rest| rest.split_once(' '))
            .map(|(address, name)| (address.to_owned(), name.trim().to_owned()))
            .collect(),
    )
}

fn watch_bluetooth(app: AppHandle) {
    let mut known: Option<HashMap<String, String>> = None;
    every(Duration::from_secs(4), move || {
        let Some(now) = bluetooth_connected() else { return };
        // A primeira leitura só registra o que já estava conectado.
        if let Some(before) = &known {
            for (address, name) in &now {
                if !before.contains_key(address) {
                    send(&app, event("bluetooth", "Bluetooth", format!("{name} conectado"), "normal", "controls", None));
                }
            }
        }
        known = Some(now);
    });
}

// --- Bateria ---------------------------------------------------------------------------

fn battery() -> Option<(u32, String)> {
    for entry in fs::read_dir("/sys/class/power_supply").ok()?.flatten() {
        let path = entry.path();
        if fs::read_to_string(path.join("type")).ok()?.trim() != "Battery" { continue; }
        let capacity = fs::read_to_string(path.join("capacity")).ok()?.trim().parse().ok()?;
        let status = fs::read_to_string(path.join("status")).ok()?.trim().to_owned();
        return Some((capacity, status));
    }
    None
}

fn watch_battery(app: AppHandle) {
    let (mut warned_low, mut warned_critical) = (false, false);
    let mut last_status = String::new();
    every(Duration::from_secs(20), move || {
        let Some((capacity, status)) = battery() else { return };
        let discharging = status == "Discharging";
        if !discharging || capacity > 25 { warned_low = false; warned_critical = false; }
        if discharging && capacity <= 10 && !warned_critical {
            warned_critical = true;
            warned_low = true;
            send(&app, event("battery-low", "Bateria crítica", format!("{capacity}% — conecte o carregador"), "warning", "controls", None));
        } else if discharging && capacity <= 20 && !warned_low {
            warned_low = true;
            send(&app, event("battery-low", "Bateria baixa", format!("{capacity}% restantes"), "warning", "controls", None));
        }
        if status == "Full" && last_status == "Charging" {
            send(&app, event("battery-full", "Carregamento concluído", "Bateria em 100%".to_owned(), "success", "controls", None));
        }
        last_status = status;
    });
}

/// Arquivos copiados no gerenciador de arquivos (a extensão avisa pelo D-Bus).
#[cfg(target_os = "linux")]
fn watch_files(app: AppHandle) {
    crate::clipboard::extension::listen(app, "FilesCopied", |app, message| {
        let Ok(list) = message.body().deserialize::<String>() else { return };
        let paths: Vec<&str> = list.lines().filter(|line| !line.is_empty()).collect();
        let Some(first) = paths.first() else { return };
        let name = Path::new(first).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let text = if paths.len() == 1 { format!("{name} copiado") } else { format!("{name} e mais {} copiados", paths.len() - 1) };
        send(app, event("files", "Copiado", text, "normal", "reveal", Some((*first).to_owned())));
    });
}

pub fn start(app: AppHandle) {
    watch_downloads(app.clone());
    watch_capture(app.clone());
    watch_bluetooth(app.clone());
    watch_battery(app.clone());
    #[cfg(target_os = "linux")]
    watch_files(app);
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}
