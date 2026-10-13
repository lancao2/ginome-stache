//! Busca de aplicativos instalados (arquivos .desktop) para a busca da ilha.
//!
//! A lista é lida sob demanda e guardada por alguns minutos; abrir um app usa `gio launch`,
//! que resolve os códigos do `Exec`, terminal e apps empacotados (Snap, Flatpak).

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock, RwLock},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::State;

const MAX_APPS: usize = 6;
const STALE_AFTER: Duration = Duration::from_secs(5 * 60);
const MAX_ICON_BYTES: u64 = 400_000;
const ICON_DIRS: &[&str] = &[
    "apps/scalable", "scalable/apps", "apps/256", "256x256/apps", "apps/128", "128x128/apps",
    "apps/64", "64x64/apps", "apps/48", "48x48/apps", "apps/32", "32x32/apps",
];

struct App {
    id: String,
    path: PathBuf,
    name: String,
    lower: String,
    /// Nome genérico e palavras-chave, em minúsculas.
    extra: String,
    icon: String,
    modified: Option<std::time::SystemTime>,
}

#[derive(Default)]
pub struct Apps {
    list: RwLock<Arc<(Vec<App>, Option<Instant>)>>,
    icons: Mutex<std::collections::HashMap<String, Option<String>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppHit {
    id: String,
    name: String,
    /// Imagem do ícone como data URI; vazio quando não foi encontrada.
    icon: String,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn app_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![home().join(".local/share/applications")];
    if let Some(data) = std::env::var_os("XDG_DATA_HOME") { dirs.push(PathBuf::from(data).join("applications")); }
    let system = std::env::var("XDG_DATA_DIRS").unwrap_or_default();
    for dir in system.split(':').filter(|dir| !dir.is_empty()) { dirs.push(Path::new(dir).join("applications")); }
    for dir in ["/usr/local/share/applications", "/usr/share/applications", "/var/lib/snapd/desktop/applications", "/var/lib/flatpak/exports/share/applications"] {
        dirs.push(PathBuf::from(dir));
    }
    dirs.push(home().join(".local/share/flatpak/exports/share/applications"));
    dirs
}

fn parse(path: &Path, id: String, locales: &[String]) -> Option<App> {
    let text = fs::read_to_string(path).ok()?;
    let (mut name, mut localized, mut generic, mut keywords, mut icon) = (String::new(), None, String::new(), String::new(), String::new());
    let mut has_exec = false;
    let mut in_entry = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') { in_entry = line == "[Desktop Entry]"; continue; }
        if !in_entry { continue; }
        let Some((key, value)) = line.split_once('=') else { continue };
        match key.trim() {
            "Type" if value != "Application" => return None,
            "NoDisplay" | "Hidden" if value.eq_ignore_ascii_case("true") => return None,
            "Exec" => has_exec = true,
            "Name" => name = value.to_owned(),
            "GenericName" => generic = value.to_owned(),
            "Keywords" => keywords = value.replace(';', " "),
            "Icon" => icon = value.to_owned(),
            key => {
                if let Some(locale) = key.strip_prefix("Name[").and_then(|rest| rest.strip_suffix(']')) {
                    if localized.is_none() && locales.iter().any(|wanted| wanted == locale) { localized = Some(value.to_owned()); }
                }
            }
        }
    }
    let name = localized.unwrap_or(name);
    if !has_exec || name.is_empty() { return None; }
    let extra = format!("{generic} {keywords} {}", id.trim_end_matches(".desktop")).to_lowercase();
    Some(App { id, path: path.to_path_buf(), lower: name.to_lowercase(), name, extra, icon, modified: None })
}

fn load() -> Vec<App> {
    let lang = std::env::var("LANG").unwrap_or_default();
    let base = lang.split('.').next().unwrap_or("").to_owned();
    let mut locales = vec![base.clone()];
    if let Some((short, _)) = base.split_once('_') { locales.push(short.to_owned()); }
    let mut seen = HashSet::new();
    let mut names = std::collections::HashMap::new();
    let mut apps = Vec::new();
    for dir in app_dirs() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "desktop") { continue; }
            let id = entry.file_name().to_string_lossy().into_owned();
            if !seen.insert(id.clone()) { continue; }
            // Um mesmo programa pode ter vários .desktop (deb, Snap, Flatpak, cópias velhas):
            // vale o modificado mais recentemente.
            if let Some(mut app) = parse(&path, id, &locales) {
                app.modified = entry.metadata().and_then(|meta| meta.modified()).ok();
                match names.get(&app.lower) {
                    None => { names.insert(app.lower.clone(), apps.len()); apps.push(app); }
                    Some(&at) if app.modified > apps[at].modified => apps[at] = app,
                    Some(_) => {}
                }
            }
        }
    }
    apps
}

fn icon_themes() -> &'static Vec<String> {
    static THEMES: OnceLock<Vec<String>> = OnceLock::new();
    THEMES.get_or_init(|| {
        let mut themes = Vec::new();
        if let Ok(output) = Command::new("gsettings").args(["get", "org.gnome.desktop.interface", "icon-theme"]).output() {
            let name = String::from_utf8_lossy(&output.stdout).trim().trim_matches('\'').to_owned();
            if !name.is_empty() { themes.push(name); }
        }
        themes.extend(["hicolor", "Yaru", "Adwaita"].map(str::to_owned));
        themes
    })
}

/// Procura o arquivo do ícone: caminho absoluto ou nome nos temas instalados.
fn find_icon(icon: &str) -> Option<PathBuf> {
    if icon.is_empty() { return None; }
    if icon.starts_with('/') { return Path::new(icon).is_file().then(|| PathBuf::from(icon)); }
    let roots = [home().join(".local/share/icons"), PathBuf::from("/usr/share/icons")];
    for theme in icon_themes() {
        for root in &roots {
            for dir in ICON_DIRS {
                for ext in ["svg", "png"] {
                    let candidate = root.join(theme).join(dir).join(format!("{icon}.{ext}"));
                    if candidate.is_file() { return Some(candidate); }
                }
            }
        }
    }
    for ext in ["svg", "png"] {
        let candidate = Path::new("/usr/share/pixmaps").join(format!("{icon}.{ext}"));
        if candidate.is_file() { return Some(candidate); }
    }
    None
}

fn icon_uri(apps: &Apps, icon: &str) -> String {
    if let Some(cached) = apps.icons.lock().ok().and_then(|cache| cache.get(icon).cloned()) { return cached.unwrap_or_default(); }
    let uri = find_icon(icon)
        .filter(|path| fs::metadata(path).is_ok_and(|meta| meta.len() <= MAX_ICON_BYTES))
        .and_then(|path| {
            let mime = match path.extension()?.to_str()? { "svg" => "image/svg+xml", "png" => "image/png", _ => return None };
            Some(format!("data:{mime};base64,{}", STANDARD.encode(fs::read(&path).ok()?)))
        });
    if let Ok(mut cache) = apps.icons.lock() { cache.insert(icon.to_owned(), uri.clone()); }
    uri.unwrap_or_default()
}

/// Menor é melhor: nome igual, começa com, início de palavra, contém, só nas palavras-chave.
fn rank(app: &App, terms: &[String]) -> Option<u32> {
    let mut best = 0;
    for term in terms {
        let points = match app.lower.find(term.as_str()) {
            Some(_) if app.lower == *term => 0,
            Some(0) => 1,
            Some(at) if !app.lower.as_bytes()[at - 1].is_ascii_alphanumeric() => 2,
            Some(_) => 3,
            None if app.extra.contains(term.as_str()) => 4,
            None => return None,
        };
        best = best.max(points);
    }
    Some(best)
}

/// Lista de apps instalados, relida se estiver velha.
fn current(apps: &Apps) -> Arc<(Vec<App>, Option<Instant>)> {
    let current = apps.list.read().map(|list| list.clone()).unwrap_or_default();
    if current.1.is_none_or(|loaded| loaded.elapsed() > STALE_AFTER) {
        let fresh = Arc::new((load(), Some(Instant::now())));
        if let Ok(mut slot) = apps.list.write() { *slot = fresh.clone(); }
        fresh
    } else {
        current
    }
}

/// Os apps com esses ids (os que ainda existem), na mesma ordem, prontos para a interface.
pub(crate) fn hits_for(apps: &Apps, ids: &[String]) -> Vec<AppHit> {
    let list = current(apps);
    ids.iter()
        .filter_map(|id| list.0.iter().find(|app| app.id == *id))
        .map(|app| AppHit { id: app.id.clone(), name: app.name.clone(), icon: icon_uri(apps, &app.icon) })
        .collect()
}

/// Nome e ícone (data URI) de um app instalado, pelo id do .desktop.
pub(crate) fn info(apps: &Apps, id: &str) -> Option<(String, String)> {
    let list = current(apps);
    let app = list.0.iter().find(|app| app.id == id)?;
    Some((app.name.clone(), icon_uri(apps, &app.icon)))
}

/// Ícone (data URI) de um nome de ícone qualquer.
pub(crate) fn icon_of(apps: &Apps, icon: &str) -> String { icon_uri(apps, icon) }

#[tauri::command(async)]
pub fn search_apps(apps: State<Arc<Apps>>, query: String) -> Vec<AppHit> {
    let terms: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_owned).collect();
    if terms.is_empty() { return Vec::new(); }
    let list = current(&apps);
    let mut found: Vec<(u32, usize, &App)> = list.0.iter().filter_map(|app| rank(app, &terms).map(|points| (points, app.name.len(), app))).collect();
    // Só o grupo mais relevante: se há nomes que começam (ou têm palavra) com o termo,
    // apps que casam no meio do nome ou só por palavra-chave ficam de fora.
    if let Some(best) = found.iter().map(|item| item.0).min() {
        let limit = if best <= 1 { 1 } else if best == 2 { 2 } else { best };
        found.retain(|item| item.0 <= limit);
    }
    found.sort_by(|a, b| (a.0, a.1, &a.2.lower).cmp(&(b.0, b.1, &b.2.lower)));
    found
        .into_iter()
        .take(MAX_APPS)
        .map(|(_, _, app)| AppHit { id: app.id.clone(), name: app.name.clone(), icon: icon_uri(&apps, &app.icon) })
        .collect()
}

/// Pede à extensão que traga à frente a janela do app, se ele já estiver aberto.
#[cfg(target_os = "linux")]
fn activate_running(id: &str) -> bool {
    let Ok(connection) = zbus::blocking::Connection::session() else { return false };
    let Ok(proxy) = crate::clipboard::extension::proxy(&connection) else { return false };
    proxy.call_method("ActivateApp", &(id,)).ok().and_then(|reply| reply.body().deserialize::<bool>().ok()).unwrap_or(false)
}
#[cfg(not(target_os = "linux"))]
fn activate_running(_id: &str) -> bool { false }

#[tauri::command(async)]
pub fn search_launch(app_handle: tauri::AppHandle, apps: State<Arc<Apps>>, id: String) -> Result<(), String> {
    crate::suggest::record(&app_handle, "app", &id);
    let list = current(&apps);
    let app = list.0.iter().find(|app| app.id == id).ok_or("Este aplicativo não está mais instalado.")?;
    if activate_running(&app.id) { return Ok(()); }
    let mut child = Command::new("gio")
        .arg("launch")
        .arg(&app.path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Não consegui abrir {}: {error}", app.name))?;
    // Recolhe o processo auxiliar quando ele terminar, sem travar a interface.
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}
