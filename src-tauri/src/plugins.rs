//! Plugins e widgets de terceiros.
//!
//! Cada plugin é uma pasta com `plugin.json` (manifesto e permissões) e um programa, em
//! qualquer linguagem, que conversa com o Stache por linhas JSON em stdin/stdout.
//!
//! Isolamento: o programa roda dentro de uma caixa do `bwrap` (bubblewrap) — sem rede, sem
//! a pasta pessoal, sem ver os outros processos, só leitura nos arquivos do sistema e no
//! próprio plugin. Para tudo o que precisa de mais (internet, comandos, avisos), o plugin
//! pede ao Stache, que confere o que o manifesto declarou e o usuário aprovou.
//! Sem o `bwrap`, nenhum plugin é executado.

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::tasks::Database;

const MAX_LINE: usize = 512 * 1024;
const MAX_BODY: u64 = 2 * 1024 * 1024;
const MAX_OUTPUT: u64 = 256 * 1024;
const EXEC_TIMEOUT: Duration = Duration::from_secs(10);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CARDS: usize = 8;
const MAX_LINES: usize = 12;
const MAX_ACTIONS: usize = 4;

// --- Manifesto -------------------------------------------------------------------------

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Permissions {
    /// Hosts que o plugin pode acessar: "api.exemplo.com", "*.exemplo.com" ou "*" (qualquer site público).
    network: Vec<String>,
    /// Comandos que pode executar no computador: cada item é o começo do comando (["docker", "ps"]).
    exec: Vec<Vec<String>>,
    /// Pode mostrar avisos na cápsula.
    alerts: bool,
    /// Tem uma pasta própria e persistente (/data).
    storage: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SettingDef {
    key: String,
    label: String,
    default: String,
    hint: String,
    /// Valor secreto (token, senha): fica no cofre do sistema, nunca no banco, e a tela o esconde.
    secret: bool,
}

impl Default for SettingDef {
    fn default() -> Self { Self { key: String::new(), label: String::new(), default: String::new(), hint: String::new(), secret: false } }
}

/// Marcador guardado no banco no lugar de um valor secreto (o valor de verdade fica no cofre).
const IN_VAULT: &str = "__vault__";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Manifest {
    id: String,
    name: String,
    version: String,
    description: String,
    /// Comando que inicia o plugin, relativo à pasta dele (["python3", "main.py"]).
    main: Vec<String>,
    permissions: Permissions,
    settings: Vec<SettingDef>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_')
}

fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let text = fs::read_to_string(dir.join("plugin.json")).map_err(|error| format!("plugin.json: {error}"))?;
    if text.len() > 64 * 1024 { return Err("plugin.json grande demais".to_owned()); }
    let manifest: Manifest = serde_json::from_str(&text).map_err(|error| format!("plugin.json inválido: {error}"))?;
    let folder = dir.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !valid_id(&manifest.id) || manifest.id != folder { return Err("o \"id\" deve ser igual ao nome da pasta (a-z, 0-9, - e _)".to_owned()); }
    if manifest.name.trim().is_empty() { return Err("falta o \"name\"".to_owned()); }
    if manifest.main.is_empty() || manifest.main.iter().any(|part| part.is_empty() || part.len() > 200) { return Err("falta o \"main\" (comando de início)".to_owned()); }
    if manifest.permissions.exec.iter().any(Vec::is_empty) { return Err("permissão \"exec\" com comando vazio".to_owned()); }
    if manifest.settings.len() > 12 || manifest.settings.iter().any(|item| item.key.is_empty() || item.key.len() > 40) { return Err("\"settings\" inválido".to_owned()); }
    Ok(manifest)
}

/// Texto que identifica as permissões: se mudarem, o plugin precisa ser aprovado de novo.
fn permission_key(permissions: &Permissions) -> String { serde_json::to_string(permissions).unwrap_or_default() }

fn permission_summary(permissions: &Permissions) -> Vec<String> {
    let mut lines = vec!["Mostrar cartões na ilha".to_owned()];
    if permissions.network.iter().any(|host| host == "*") {
        lines.push("Acessar qualquer site da internet".to_owned());
    } else if !permissions.network.is_empty() {
        lines.push(format!("Acessar a internet: {}", permissions.network.join(", ")));
    }
    if !permissions.exec.is_empty() {
        let commands: Vec<String> = permissions.exec.iter().map(|command| command.join(" ")).collect();
        lines.push(format!("Executar comandos no computador: {}", commands.join("; ")));
    }
    if permissions.alerts { lines.push("Mostrar avisos na cápsula".to_owned()); }
    if permissions.storage { lines.push("Guardar arquivos próprios".to_owned()); }
    lines
}

// --- Estado ----------------------------------------------------------------------------

struct Instance {
    manifest: Manifest,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    stop: AtomicBool,
    started: Instant,
}

#[derive(Default)]
pub struct Plugins {
    running: Mutex<HashMap<String, Arc<Instance>>>,
    cards: Mutex<HashMap<String, (String, Vec<Card>)>>,
    status: Mutex<HashMap<String, String>>,
    restarts: Mutex<HashMap<String, u32>>,
    alert_times: Mutex<HashMap<String, Vec<Instant>>>,
    card_times: Mutex<HashMap<String, (Instant, u32)>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    label: String,
    value: String,
    tone: String,
}

#[derive(Clone, Serialize)]
pub struct Action {
    id: String,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    id: String,
    title: String,
    subtitle: Option<String>,
    icon: Option<String>,
    body: Option<String>,
    progress: Option<f64>,
    lines: Vec<Line>,
    actions: Vec<Action>,
    url: Option<String>,
    tone: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCards {
    plugin_id: String,
    plugin_name: String,
    cards: Vec<Card>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    id: String,
    name: String,
    version: String,
    description: String,
    permissions: Vec<String>,
    settings: Vec<SettingDef>,
    values: HashMap<String, String>,
    enabled: bool,
    /// O usuário aprovou as permissões atuais do manifesto.
    approved: bool,
    status: String,
    /// Falso quando o bwrap não está instalado.
    sandboxed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginError {
    folder: String,
    error: String,
}

#[derive(Serialize)]
pub struct PluginList {
    plugins: Vec<PluginInfo>,
    errors: Vec<PluginError>,
    dir: String,
}

fn root(app: &AppHandle) -> PathBuf { app.path().app_data_dir().unwrap_or_default().join("plugins") }
fn sdk_dir(app: &AppHandle) -> PathBuf { app.path().app_data_dir().unwrap_or_default().join("plugin-sdk") }
fn data_dir(app: &AppHandle, id: &str) -> PathBuf { app.path().app_data_dir().unwrap_or_default().join("plugin-data").join(id) }

fn sandbox_available() -> bool {
    Command::new("bwrap").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|status| status.success())
}

// --- Banco -----------------------------------------------------------------------------

struct Stored {
    enabled: bool,
    approved: String,
    values: HashMap<String, String>,
}

fn ensure_table(db: &Database) {
    if let Ok(connection) = db.lock() {
        let _ = connection.execute_batch("CREATE TABLE IF NOT EXISTS plugin_state (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, approved TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}');");
    }
}

fn stored(db: &Database, id: &str) -> Stored {
    ensure_table(db);
    let empty = Stored { enabled: false, approved: String::new(), values: HashMap::new() };
    let Ok(connection) = db.lock() else { return empty };
    connection
        .query_row("SELECT enabled, approved, settings FROM plugin_state WHERE id = ?1", [id], |row| {
            let settings: String = row.get(2)?;
            Ok(Stored { enabled: row.get::<_, i64>(0)? != 0, approved: row.get(1)?, values: serde_json::from_str(&settings).unwrap_or_default() })
        })
        .unwrap_or(empty)
}

fn save(db: &Database, id: &str, state: &Stored) -> Result<(), String> {
    ensure_table(db);
    let settings = serde_json::to_string(&state.values).map_err(|error| error.to_string())?;
    db.lock()?
        .execute(
            "INSERT INTO plugin_state (id, enabled, approved, settings) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET enabled = ?2, approved = ?3, settings = ?4",
            rusqlite::params![id, i64::from(state.enabled), state.approved, settings],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Valores para a tela: opções secretas nunca saem do cofre (a tela só sabe se há um valor).
fn effective_values(manifest: &Manifest, stored: &Stored) -> HashMap<String, String> {
    manifest.settings.iter().map(|item| {
        let value = stored.values.get(&item.key).cloned().unwrap_or_else(|| item.default.clone());
        (item.key.clone(), if item.secret && value == IN_VAULT { IN_VAULT.to_owned() } else if item.secret { String::new() } else { value })
    }).collect()
}

/// Valores entregues ao plugin ao iniciar: aqui os segredos são lidos do cofre.
fn init_values(app: &AppHandle, manifest: &Manifest, stored: &Stored) -> HashMap<String, String> {
    manifest.settings.iter().map(|item| {
        let value = stored.values.get(&item.key).cloned().unwrap_or_else(|| item.default.clone());
        let value = if item.secret { crate::vault::get(app, "plugin", &format!("{}/{}", manifest.id, item.key)).unwrap_or_default() } else { value };
        (item.key.clone(), value)
    }).collect()
}

// --- Cartões ---------------------------------------------------------------------------

fn text(value: &Value, key: &str, max: usize) -> Option<String> {
    let raw = match &value[key] { Value::String(text) => text.clone(), Value::Number(number) => number.to_string(), _ => return None };
    let trimmed: String = raw.chars().filter(|ch| !ch.is_control() || *ch == '\n').take(max).collect();
    (!trimmed.trim().is_empty()).then_some(trimmed)
}

fn tone(value: &Value, key: &str) -> String {
    match value[key].as_str() { Some(tone @ ("success" | "warning" | "danger")) => tone.to_owned(), _ => "normal".to_owned() }
}

fn web_url(value: &Value, key: &str) -> Option<String> {
    let candidate = text(value, key, 500)?;
    let parsed = url::Url::parse(&candidate).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.to_string())
}

fn parse_card(value: &Value) -> Option<Card> {
    let id = text(value, "id", 40)?;
    let lines = value["lines"].as_array().map(|list| list.iter().take(MAX_LINES).filter_map(|line| Some(Line {
        label: text(line, "label", 60)?,
        value: text(line, "value", 120).unwrap_or_default(),
        tone: tone(line, "tone"),
    })).collect()).unwrap_or_default();
    let actions = value["actions"].as_array().map(|list| list.iter().take(MAX_ACTIONS).filter_map(|action| Some(Action { id: text(action, "id", 40)?, label: text(action, "label", 24)? })).collect()).unwrap_or_default();
    Some(Card {
        id,
        title: text(value, "title", 60).unwrap_or_default(),
        subtitle: text(value, "subtitle", 80),
        icon: text(value, "icon", 30),
        body: text(value, "body", 300),
        progress: value["progress"].as_f64().map(|progress| progress.clamp(0.0, 1.0)),
        lines,
        actions,
        url: web_url(value, "url"),
        tone: tone(value, "tone"),
    })
}

fn emit_cards(app: &AppHandle, plugins: &Plugins) {
    let Ok(cards) = plugins.cards.lock() else { return };
    let mut all: Vec<PluginCards> = cards.iter().filter(|(_, (_, list))| !list.is_empty())
        .map(|(id, (name, list))| PluginCards { plugin_id: id.clone(), plugin_name: name.clone(), cards: list.clone() }).collect();
    all.sort_by(|a, b| a.plugin_name.cmp(&b.plugin_name));
    let _ = app.emit("plugin-cards", all);
}

// --- Broker: internet e comandos -------------------------------------------------------

fn host_allowed(allowed: &[String], host: &str) -> bool {
    let host = host.to_lowercase();
    allowed.iter().any(|rule| {
        let rule = rule.to_lowercase();
        if rule == "*" { return true; }
        match rule.strip_prefix("*.") { Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")), None => host == rule }
    })
}

fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]),
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

fn http_request(manifest: &Manifest, request: &Value) -> Value {
    let Some(address) = request["url"].as_str().and_then(|raw| url::Url::parse(raw).ok()) else { return json!({"ok": false, "error": "endereço inválido"}) };
    if !matches!(address.scheme(), "http" | "https") { return json!({"ok": false, "error": "só http e https"}); }
    let Some(host) = address.host_str().map(str::to_owned) else { return json!({"ok": false, "error": "endereço sem host"}) };
    let allowed = &manifest.permissions.network;
    if !host_allowed(allowed, &host) { return json!({"ok": false, "error": format!("o plugin não tem permissão para acessar {host}")}); }
    // "*" cobre a internet pública; rede local só se o host estiver listado por extenso.
    let explicit = allowed.iter().any(|rule| rule.eq_ignore_ascii_case(&host));
    if !explicit {
        let port = address.port_or_known_default().unwrap_or(443);
        let local_name = host == "localhost" || host.ends_with(".local") || host.ends_with(".internal");
        let resolved_private = (host.as_str(), port).to_socket_addrs().map(|mut list| list.any(|socket| is_private(socket.ip()))).unwrap_or(false);
        if local_name || resolved_private { return json!({"ok": false, "error": "endereços da rede local precisam estar listados no manifesto"}); }
    }
    let head = request["method"].as_str() == Some("HEAD");
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(HTTP_TIMEOUT))
        .http_status_as_error(false)
        // Sem redirecionamento automático: um redirecionamento poderia sair da lista de hosts permitidos.
        .max_redirects(0)
        .max_redirects_will_error(false)
        .build();
    let agent: ureq::Agent = config.into();
    let mut builder = if head { agent.head(address.as_str()) } else { agent.get(address.as_str()) };
    builder = builder.header("User-Agent", "Stache-Plugin/1.0");
    if let Some(headers) = request["headers"].as_object() {
        for (name, value) in headers.iter().take(10) {
            let Some(value) = value.as_str() else { continue };
            if name.eq_ignore_ascii_case("host") || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') || value.len() > 2000 { continue; }
            builder = builder.header(name.as_str(), value);
        }
    }
    let started = Instant::now();
    match builder.call() {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let location = response.headers().get("location").and_then(|value| value.to_str().ok()).map(str::to_owned);
            let content_type = response.headers().get("content-type").and_then(|value| value.to_str().ok()).map(str::to_owned);
            let body = if head { String::new() } else { response.body_mut().with_config().limit(MAX_BODY).read_to_string().unwrap_or_default() };
            json!({"ok": true, "status": status, "body": body, "location": location, "content_type": content_type, "elapsed_ms": started.elapsed().as_millis() as u64})
        }
        Err(error) => json!({"ok": false, "error": error.to_string(), "elapsed_ms": started.elapsed().as_millis() as u64}),
    }
}

fn exec_request(manifest: &Manifest, request: &Value) -> Value {
    let Some(argv) = request["argv"].as_array().map(|list| list.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect::<Vec<_>>()) else { return json!({"ok": false, "error": "argv inválido"}) };
    if argv.is_empty() || argv.len() > 32 || argv.iter().any(|part| part.len() > 2000 || part.contains('\0')) { return json!({"ok": false, "error": "comando inválido"}); }
    let allowed = manifest.permissions.exec.iter().any(|prefix| argv.len() >= prefix.len() && argv[..prefix.len()] == prefix[..]);
    if !allowed { return json!({"ok": false, "error": format!("o plugin não tem permissão para executar: {}", argv.join(" "))}); }
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]).env_clear().env("PATH", "/usr/local/bin:/usr/bin:/bin").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for name in ["HOME", "DOCKER_HOST", "XDG_RUNTIME_DIR", "LANG"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    let mut child = match command.spawn() { Ok(child) => child, Err(error) => return json!({"ok": false, "error": format!("não consegui executar: {error}")}) };
    let reader = |stream: Option<Box<dyn Read + Send>>| thread::spawn(move || { let mut out = Vec::new(); if let Some(stream) = stream { let _ = stream.take(MAX_OUTPUT).read_to_end(&mut out); } String::from_utf8_lossy(&out).into_owned() });
    let stdout = reader(child.stdout.take().map(|stream| Box::new(stream) as Box<dyn Read + Send>));
    let stderr = reader(child.stderr.take().map(|stream| Box::new(stream) as Box<dyn Read + Send>));
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() > EXEC_TIMEOUT => { let _ = child.kill(); let _ = child.wait(); return json!({"ok": false, "error": "o comando demorou mais de 10 s"}); }
            Ok(None) => thread::sleep(Duration::from_millis(30)),
            Err(error) => return json!({"ok": false, "error": error.to_string()}),
        }
    };
    json!({"ok": true, "code": code, "stdout": stdout.join().unwrap_or_default(), "stderr": stderr.join().unwrap_or_default()})
}

fn reply(instance: &Instance, value: &Value) {
    if let Ok(mut stdin) = instance.stdin.lock() {
        let _ = writeln!(stdin, "{value}");
        let _ = stdin.flush();
    }
}

// --- Avisos ----------------------------------------------------------------------------

fn plugin_alert(app: &AppHandle, plugins: &Plugins, instance: &Instance, message: &Value) {
    if !instance.manifest.permissions.alerts { return; }
    {
        // No máximo 1 aviso a cada 3 s e 20 por hora, por plugin.
        let Ok(mut times) = plugins.alert_times.lock() else { return };
        let list = times.entry(instance.manifest.id.clone()).or_default();
        list.retain(|at| at.elapsed() < Duration::from_secs(3600));
        if list.len() >= 20 || list.last().is_some_and(|at| at.elapsed() < Duration::from_secs(3)) { return; }
        list.push(Instant::now());
    }
    let Some(body) = text(message, "text", 140) else { return };
    let label = text(message, "label", 40).unwrap_or_else(|| instance.manifest.name.clone());
    let tone = match message["tone"].as_str() { Some("success") => "success", Some("warning" | "danger") => "warning", _ => "normal" };
    let link = web_url(message, "url");
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload { kind: &'static str, label: String, text: String, tone: &'static str, action: &'static str, path: Option<String> }
    let _ = app.emit("context-event", Payload { kind: "plugin", label, text: body, tone, action: if link.is_some() { "url" } else { "none" }, path: link });
}

// --- Execução --------------------------------------------------------------------------

fn set_status(plugins: &Plugins, id: &str, status: impl Into<String>) {
    if let Ok(mut map) = plugins.status.lock() { map.insert(id.to_owned(), status.into()); }
}

fn bwrap_command(app: &AppHandle, manifest: &Manifest, dir: &Path) -> Command {
    let mut command = Command::new("bwrap");
    command.args(["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"]);
    command.args(["--ro-bind", "/usr", "/usr"]);
    for link in ["/bin", "/sbin", "/lib", "/lib64"] {
        match fs::read_link(link) {
            Ok(target) => { command.arg("--symlink").arg(target).arg(link); }
            Err(_) if Path::new(link).is_dir() => { command.args(["--ro-bind", link, link]); }
            Err(_) => {}
        }
    }
    for path in ["/etc/alternatives", "/etc/localtime", "/etc/ld.so.cache"] { command.args(["--ro-bind-try", path, path]); }
    command.args(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);
    command.arg("--ro-bind").arg(dir).arg("/plugin");
    command.arg("--ro-bind").arg(sdk_dir(app)).arg("/sdk");
    if manifest.permissions.storage {
        let data = data_dir(app, &manifest.id);
        let _ = fs::create_dir_all(&data);
        command.arg("--bind").arg(data).arg("/data");
    } else {
        command.args(["--tmpfs", "/data"]);
    }
    for (name, value) in [("PATH", "/usr/local/bin:/usr/bin:/bin"), ("HOME", "/data"), ("LANG", "C.UTF-8"), ("PYTHONPATH", "/sdk"), ("PYTHONDONTWRITEBYTECODE", "1"), ("PYTHONUNBUFFERED", "1"), ("STACHE_PLUGIN_ID", manifest.id.as_str())] {
        command.args(["--setenv", name, value]);
    }
    command.args(["--chdir", "/plugin", "--"]).args(&manifest.main);
    command
}

fn stop_plugin(app: &AppHandle, plugins: &Plugins, id: &str) {
    let instance = plugins.running.lock().ok().and_then(|mut map| map.remove(id));
    if let Some(instance) = instance {
        instance.stop.store(true, Ordering::SeqCst);
        if let Ok(mut child) = instance.child.lock() { let _ = child.kill(); let _ = child.wait(); }
    }
    if let Ok(mut cards) = plugins.cards.lock() { cards.remove(id); }
    emit_cards(app, plugins);
}

fn start_plugin(app: &AppHandle, id: &str) {
    let (Some(plugins), Some(db)) = (app.try_state::<Arc<Plugins>>(), app.try_state::<Database>()) else { return };
    let plugins: Arc<Plugins> = plugins.inner().clone();
    if plugins.running.lock().map(|map| map.contains_key(id)).unwrap_or(true) { return; }
    let dir = root(app).join(id);
    let manifest = match read_manifest(&dir) { Ok(manifest) => manifest, Err(error) => { set_status(&plugins, id, format!("erro no manifesto: {error}")); return; } };
    let state = stored(&db, id);
    if !state.enabled { return; }
    if state.approved != permission_key(&manifest.permissions) { set_status(&plugins, id, "as permissões mudaram: aprove de novo"); return; }
    if !sandbox_available() { set_status(&plugins, id, "bubblewrap (bwrap) não está instalado: o plugin não roda sem isolamento"); return; }

    let mut command = bwrap_command(app, &manifest, &dir);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match command.spawn() { Ok(child) => child, Err(error) => { set_status(&plugins, id, format!("não consegui iniciar: {error}")); return; } };
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else { let _ = child.kill(); return };
    let instance = Arc::new(Instance { manifest: manifest.clone(), stdin: Mutex::new(stdin), child: Mutex::new(child), stop: AtomicBool::new(false), started: Instant::now() });
    if let Ok(mut map) = plugins.running.lock() { map.insert(id.to_owned(), instance.clone()); }
    set_status(&plugins, id, "rodando");
    reply(&instance, &json!({"type": "init", "settings": init_values(app, &manifest, &state)}));

    // Última linha de erro do plugin, útil para quem o está escrevendo.
    {
        let (app, plugins, id) = (app.clone(), plugins.clone(), id.to_owned());
        let _ = app;
        thread::spawn(move || {
            for line in BufReader::new(stderr.take(64 * 1024)).lines().map_while(Result::ok) {
                if !line.trim().is_empty() { set_status(&plugins, &id, format!("rodando · {}", line.chars().take(160).collect::<String>())); }
            }
        });
    }

    let (app, id) = (app.clone(), id.to_owned());
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.by_ref().take(MAX_LINE as u64 + 1).read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > MAX_LINE => { set_status(&plugins, &id, "mensagem grande demais"); break; }
                Ok(_) => {}
            }
            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { continue };
            handle(&app, &plugins, &instance, message);
        }
        // O plugin terminou (ou foi encerrado).
        let current = plugins.running.lock().ok().is_some_and(|mut map| map.get(&id).is_some_and(|running| Arc::ptr_eq(running, &instance)) && map.remove(&id).is_some());
        if let Ok(mut child) = instance.child.lock() { let _ = child.kill(); let _ = child.wait(); }
        if let Ok(mut cards) = plugins.cards.lock() { cards.remove(&id); }
        emit_cards(&app, &plugins);
        if instance.stop.load(Ordering::SeqCst) || !current { return; }
        let ran = instance.started.elapsed();
        let attempt = {
            let Ok(mut restarts) = plugins.restarts.lock() else { return };
            let count = restarts.entry(id.clone()).or_insert(0);
            if ran > Duration::from_secs(60) { *count = 0; }
            *count += 1;
            *count
        };
        if attempt > 5 { set_status(&plugins, &id, "parou de funcionar (falhou 5 vezes seguidas)"); return; }
        let wait = Duration::from_secs((2u64 << attempt.min(5)).min(60));
        set_status(&plugins, &id, format!("reiniciando em {} s…", wait.as_secs()));
        thread::sleep(wait);
        start_plugin(&app, &id);
    });
}

fn handle(app: &AppHandle, plugins: &Arc<Plugins>, instance: &Arc<Instance>, message: Value) {
    let id = &instance.manifest.id;
    match message["type"].as_str() {
        Some("card") => {
            {
                // Até 20 atualizações por segundo.
                let Ok(mut times) = plugins.card_times.lock() else { return };
                let slot = times.entry(id.clone()).or_insert((Instant::now(), 0));
                if slot.0.elapsed() >= Duration::from_secs(1) { *slot = (Instant::now(), 0); }
                slot.1 += 1;
                if slot.1 > 20 { return; }
            }
            let Some(card) = parse_card(&message) else { return };
            if let Ok(mut cards) = plugins.cards.lock() {
                let entry = cards.entry(id.clone()).or_insert_with(|| (instance.manifest.name.clone(), Vec::new()));
                if let Some(at) = entry.1.iter().position(|existing| existing.id == card.id) {
                    entry.1[at] = card;
                } else if entry.1.len() < MAX_CARDS {
                    entry.1.push(card);
                } else {
                    return;
                }
            }
            emit_cards(app, plugins);
        }
        Some("remove_card") => {
            let Some(card) = text(&message, "id", 40) else { return };
            if let Ok(mut cards) = plugins.cards.lock() { if let Some(entry) = cards.get_mut(id) { entry.1.retain(|existing| existing.id != card); } }
            emit_cards(app, plugins);
        }
        Some("alert") => plugin_alert(app, plugins, instance, &message),
        Some("request") => {
            let instance = instance.clone();
            thread::spawn(move || {
                let mut answer = match message["op"].as_str() {
                    Some("http") => http_request(&instance.manifest, &message),
                    Some("exec") => exec_request(&instance.manifest, &message),
                    _ => json!({"ok": false, "error": "operação desconhecida"}),
                };
                if let Some(object) = answer.as_object_mut() {
                    object.insert("type".to_owned(), json!("response"));
                    object.insert("req".to_owned(), message["req"].clone());
                }
                reply(&instance, &answer);
            });
        }
        _ => {}
    }
}

// --- Comandos --------------------------------------------------------------------------

#[tauri::command]
pub fn plugins_list(app: AppHandle, plugins: State<Arc<Plugins>>, db: State<Database>) -> PluginList {
    let dir = root(&app);
    let sandboxed = sandbox_available();
    let (mut found, mut errors) = (Vec::new(), Vec::new());
    if let Ok(read) = fs::read_dir(&dir) {
        for entry in read.flatten().filter(|entry| entry.path().is_dir()) {
            let folder = entry.file_name().to_string_lossy().into_owned();
            match read_manifest(&entry.path()) {
                Ok(manifest) => {
                    let state = stored(&db, &manifest.id);
                    let approved = state.approved == permission_key(&manifest.permissions);
                    let status = plugins.status.lock().ok().and_then(|map| map.get(&manifest.id).cloned());
                    let running = plugins.running.lock().map(|map| map.contains_key(&manifest.id)).unwrap_or(false);
                    found.push(PluginInfo {
                        id: manifest.id.clone(),
                        name: manifest.name.clone(),
                        version: manifest.version.clone(),
                        description: manifest.description.clone(),
                        permissions: permission_summary(&manifest.permissions),
                        settings: manifest.settings.clone(),
                        values: effective_values(&manifest, &state),
                        enabled: state.enabled && approved,
                        approved,
                        status: if running || state.enabled { status.unwrap_or_else(|| "iniciando…".to_owned()) } else { "desligado".to_owned() },
                        sandboxed,
                    });
                }
                Err(error) => errors.push(PluginError { folder, error }),
            }
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    PluginList { plugins: found, errors, dir: dir.to_string_lossy().into_owned() }
}

#[tauri::command(async)]
pub fn plugins_set_enabled(app: AppHandle, plugins: State<Arc<Plugins>>, db: State<Database>, id: String, enabled: bool) -> Result<(), String> {
    if !valid_id(&id) { return Err("plugin inválido".to_owned()); }
    let manifest = read_manifest(&root(&app).join(&id))?;
    let mut state = stored(&db, &id);
    state.enabled = enabled;
    // Ligar é a aprovação das permissões que o usuário viu na tela.
    if enabled { state.approved = permission_key(&manifest.permissions); }
    save(&db, &id, &state)?;
    if let Ok(mut restarts) = plugins.restarts.lock() { restarts.remove(&id); }
    stop_plugin(&app, &plugins, &id);
    if enabled { set_status(&plugins, &id, "iniciando…"); start_plugin(&app, &id); } else { set_status(&plugins, &id, "desligado"); }
    Ok(())
}

#[tauri::command(async)]
pub fn plugins_set_setting(app: AppHandle, plugins: State<Arc<Plugins>>, db: State<Database>, id: String, key: String, value: String) -> Result<(), String> {
    if !valid_id(&id) { return Err("plugin inválido".to_owned()); }
    let manifest = read_manifest(&root(&app).join(&id))?;
    let Some(definition) = manifest.settings.iter().find(|item| item.key == key) else { return Err("opção desconhecida".to_owned()) };
    let mut state = stored(&db, &id);
    let value: String = value.chars().take(500).collect();
    if definition.secret {
        // Segredo: vai para o cofre; o banco guarda só o marcador (ou nada, se foi apagado).
        let slot = format!("{id}/{key}");
        if value.is_empty() {
            crate::vault::delete(&app, "plugin", &slot);
            state.values.remove(&key);
        } else {
            crate::vault::set(&app, "plugin", &slot, &value)?;
            state.values.insert(key, IN_VAULT.to_owned());
        }
    } else {
        state.values.insert(key, value);
    }
    save(&db, &id, &state)?;
    if plugins.running.lock().map(|map| map.contains_key(&id)).unwrap_or(false) {
        stop_plugin(&app, &plugins, &id);
        start_plugin(&app, &id);
    }
    Ok(())
}

#[tauri::command]
pub fn plugins_cards(plugins: State<Arc<Plugins>>) -> Vec<PluginCards> {
    let Ok(cards) = plugins.cards.lock() else { return Vec::new() };
    let mut all: Vec<PluginCards> = cards.iter().filter(|(_, (_, list))| !list.is_empty())
        .map(|(id, (name, list))| PluginCards { plugin_id: id.clone(), plugin_name: name.clone(), cards: list.clone() }).collect();
    all.sort_by(|a, b| a.plugin_name.cmp(&b.plugin_name));
    all
}

#[tauri::command]
pub fn plugin_action(plugins: State<Arc<Plugins>>, plugin: String, card: String, action: String) {
    let instance = plugins.running.lock().ok().and_then(|map| map.get(&plugin).cloned());
    if let Some(instance) = instance { reply(&instance, &json!({"type": "action", "card": card, "action": action})); }
}

const EXAMPLES: &[(&str, &str, &str)] = &[
    ("timer", include_str!("../../plugins/examples/timer/plugin.json"), include_str!("../../plugins/examples/timer/main.py")),
    ("quote", include_str!("../../plugins/examples/quote/plugin.json"), include_str!("../../plugins/examples/quote/main.py")),
    ("github", include_str!("../../plugins/examples/github/plugin.json"), include_str!("../../plugins/examples/github/main.py")),
    ("docker", include_str!("../../plugins/examples/docker/plugin.json"), include_str!("../../plugins/examples/docker/main.py")),
    ("status", include_str!("../../plugins/examples/status/plugin.json"), include_str!("../../plugins/examples/status/main.py")),
];
const SDK: &str = include_str!("../../plugins/sdk/stache.py");

/// Copia os plugins de exemplo (sem sobrescrever os que já existem).
#[tauri::command]
pub fn plugins_install_examples(app: AppHandle) -> Result<usize, String> {
    let mut installed = 0;
    for (id, manifest, main) in EXAMPLES {
        let dir = root(&app).join(id);
        if dir.exists() { continue; }
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        fs::write(dir.join("plugin.json"), manifest).map_err(|error| error.to_string())?;
        fs::write(dir.join("main.py"), main).map_err(|error| error.to_string())?;
        installed += 1;
    }
    Ok(installed)
}

#[tauri::command]
pub fn plugins_open_dir(app: AppHandle) -> Result<(), String> {
    let dir = root(&app);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Command::new("xdg-open").arg(dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|_| ()).map_err(|error| error.to_string())
}

/// Prepara as pastas, grava o SDK e liga os plugins que o usuário já aprovou.
pub fn start(app: AppHandle) {
    let _ = fs::create_dir_all(root(&app));
    let sdk = sdk_dir(&app);
    if fs::create_dir_all(&sdk).is_ok() { let _ = fs::write(sdk.join("stache.py"), SDK); }
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(2));
        // Plugins podem precisar de segredos do cofre: esperam a tela ser desbloqueada.
        crate::session::wait_unlocked();
        let Some(db) = app.try_state::<Database>() else { return };
        let Ok(read) = fs::read_dir(root(&app)) else { return };
        for entry in read.flatten().filter(|entry| entry.path().is_dir()) {
            let id = entry.file_name().to_string_lossy().into_owned();
            if valid_id(&id) && stored(&db, &id).enabled { start_plugin(&app, &id); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_rules() {
        let rules = vec!["api.exemplo.com".to_owned(), "*.cdn.com".to_owned()];
        assert!(host_allowed(&rules, "API.exemplo.com"));
        assert!(host_allowed(&rules, "a.cdn.com") && host_allowed(&rules, "cdn.com"));
        assert!(!host_allowed(&rules, "evil-cdn.com") && !host_allowed(&rules, "exemplo.com"));
        assert!(host_allowed(&["*".to_owned()], "qualquer.com"));
    }

    #[test]
    fn exec_prefixes() {
        let manifest = Manifest { permissions: Permissions { exec: vec![vec!["docker".into(), "ps".into()]], ..Default::default() }, ..Default::default() };
        assert_eq!(exec_request(&manifest, &json!({"argv": ["rm", "-rf", "/"]}))["ok"], false);
        assert_eq!(exec_request(&manifest, &json!({"argv": ["docker", "run", "x"]}))["ok"], false);
        assert_eq!(exec_request(&manifest, &json!({"argv": ["docker"]}))["ok"], false);
        let allowed = Manifest { permissions: Permissions { exec: vec![vec!["echo".into()]], ..Default::default() }, ..Default::default() };
        let answer = exec_request(&allowed, &json!({"argv": ["echo", "oi"]}));
        assert_eq!(answer["stdout"], "oi\n");
    }

    #[test]
    fn network_blocks_local_and_unlisted() {
        let manifest = Manifest { permissions: Permissions { network: vec!["*".into()], ..Default::default() }, ..Default::default() };
        assert_eq!(http_request(&manifest, &json!({"url": "http://127.0.0.1:8080/"}))["ok"], false);
        assert_eq!(http_request(&manifest, &json!({"url": "http://localhost/"}))["ok"], false);
        let limited = Manifest { permissions: Permissions { network: vec!["api.exemplo.com".into()], ..Default::default() }, ..Default::default() };
        assert!(http_request(&limited, &json!({"url": "https://outro.com/"}))["error"].as_str().unwrap().contains("permissão"));
    }

    #[test]
    #[ignore]
    fn live_http() {
        let manifest = Manifest { permissions: Permissions { network: vec!["economia.awesomeapi.com.br".into(), "example.com".into()], ..Default::default() }, ..Default::default() };
        let answer = http_request(&manifest, &json!({"url": "https://economia.awesomeapi.com.br/last/USD-BRL"}));
        println!("{answer}");
        assert_eq!(answer["status"], 200);
        let head = http_request(&manifest, &json!({"url": "https://example.com/", "method": "HEAD"}));
        println!("{head}");
        assert_eq!(head["status"], 200);
        let redirect = http_request(&Manifest { permissions: Permissions { network: vec!["*".into()], ..Default::default() }, ..Default::default() }, &json!({"url": "http://example.com/"}));
        println!("{redirect}");
    }

    #[test]
    fn cards_are_sanitized() {
        let card = parse_card(&json!({"id": "a", "title": "T", "progress": 9.0, "url": "javascript:alert(1)", "lines": [{"label": "x", "value": 5, "tone": "bogus"}]})).unwrap();
        assert_eq!(card.progress, Some(1.0));
        assert!(card.url.is_none());
        assert_eq!(card.lines[0].value, "5");
        assert_eq!(card.lines[0].tone, "normal");
    }
}
