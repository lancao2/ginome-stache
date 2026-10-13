//! Limites de uso das IAs instaladas no computador.
//!
//! Lê o login que o próprio Claude Code e o Codex já guardam no disco e consulta
//! os endpoints de uso dos respectivos fornecedores. Nada é gravado e os tokens
//! só são enviados ao fornecedor a que pertencem.

use std::{fs, path::PathBuf, time::Duration};

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// "session" (janela curta de 5 h) ou "weekly".
    id: &'static str,
    used_percent: f64,
    resets_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    id: &'static str,
    name: &'static str,
    /// "ok", "no_login", "error" ou "unsupported".
    status: &'static str,
    plan: Option<String>,
    note: Option<String>,
    windows: Vec<UsageWindow>,
}

impl AiUsage {
    fn new(id: &'static str, name: &'static str, status: &'static str) -> Self {
        Self { id, name, status, plan: None, note: None, windows: Vec::new() }
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn read_json(path: PathBuf) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn percent(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str().and_then(|text| text.parse().ok())).map(|number| number.clamp(0.0, 100.0))
}

fn get_json(url: &str, headers: &[(&str, &str)]) -> Result<Value, ureq::Error> {
    let mut request = ureq::get(url).config().timeout_global(Some(Duration::from_secs(10))).build();
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request.call()?.body_mut().read_json::<Value>()
}

fn status_of(error: &ureq::Error) -> (&'static str, String) {
    match error {
        ureq::Error::StatusCode(401 | 403) => ("no_login", "login expirado".to_owned()),
        ureq::Error::StatusCode(code) => ("error", format!("HTTP {code}")),
        other => ("error", other.to_string()),
    }
}

fn claude() -> AiUsage {
    let mut usage = AiUsage::new("claude", "Claude Code", "unsupported");
    let mut profiles = vec![home().join(".claude")];
    if let Ok(entries) = fs::read_dir(home()) {
        profiles.extend(entries.flatten().filter(|entry| entry.file_name().to_string_lossy().starts_with(".claude-")).map(|entry| entry.path()));
    }
    profiles.retain(|path| path.exists());
    if profiles.is_empty() {
        usage.status = "absent";
        return usage;
    }
    usage.status = "no_login";
    for profile in profiles {
        let Some(credentials) = read_json(profile.join(".credentials.json")).or_else(|| read_json(profile.join("credentials.json"))) else { continue };
        let oauth = credentials.get("claudeAiOauth").unwrap_or(&credentials);
        let Some(token) = oauth.get("accessToken").and_then(Value::as_str).map(str::trim).filter(|token| !token.is_empty()) else { continue };
        usage.plan = oauth.get("subscriptionType").and_then(Value::as_str).map(str::to_owned);
        let bearer = format!("Bearer {token}");
        match get_json("https://api.anthropic.com/api/oauth/usage", &[("authorization", &bearer), ("anthropic-beta", "oauth-2025-04-20")]) {
            Ok(json) => {
                usage.status = "ok";
                for (field, id) in [("five_hour", "session"), ("seven_day", "weekly")] {
                    let item = &json[field];
                    if let Some(used) = percent(&item["utilization"]) {
                        usage.windows.push(UsageWindow { id, used_percent: used, resets_at: item["resets_at"].as_str().map(str::to_owned) });
                    }
                }
            }
            Err(error) => {
                let (status, note) = status_of(&error);
                usage.status = status;
                usage.note = Some(note);
            }
        }
        return usage;
    }
    usage
}

fn codex() -> AiUsage {
    let mut usage = AiUsage::new("codex", "Codex", "absent");
    let root = home().join(".codex");
    if !root.exists() {
        return usage;
    }
    usage.status = "no_login";
    let Some(auth) = read_json(root.join("auth.json")) else { return usage };
    let (Some(token), Some(account)) = (
        auth["tokens"]["access_token"].as_str().filter(|token| !token.is_empty()),
        auth["tokens"]["account_id"].as_str().filter(|account| !account.is_empty()),
    ) else { return usage };
    let bearer = format!("Bearer {token}");
    match get_json("https://chatgpt.com/backend-api/wham/usage", &[("authorization", &bearer), ("chatgpt-account-id", account), ("accept", "application/json")]) {
        Ok(json) => {
            usage.status = "ok";
            usage.plan = json["plan_type"].as_str().map(str::to_owned);
            for (field, id) in [("primary_window", "session"), ("secondary_window", "weekly")] {
                let item = &json["rate_limit"][field];
                let Some(used) = percent(&item["used_percent"]) else { continue };
                let resets_at = item["reset_at"].as_i64().map(|seconds| seconds).or_else(|| {
                    item["reset_after_seconds"].as_i64().map(|after| now_seconds() + after)
                }).and_then(|seconds| unix_to_iso(seconds));
                usage.windows.push(UsageWindow { id, used_percent: used, resets_at });
            }
        }
        Err(error) => {
            let (status, note) = status_of(&error);
            usage.status = status;
            usage.note = Some(note);
        }
    }
    usage
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Converte segundos Unix para um instante ISO-8601 em UTC.
fn unix_to_iso(seconds: i64) -> Option<String> {
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    // Algoritmo de data civil de Howard Hinnant.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    Some(format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3_600, rest % 3_600 / 60, rest % 60))
}

/// Outras IAs instaladas, para as quais ainda não existe leitura de limite.
fn others() -> Vec<AiUsage> {
    let mut list = Vec::new();
    if home().join(".gemini").exists() {
        let mut gemini = AiUsage::new("gemini", "Gemini", "unsupported");
        gemini.note = Some("limites indisponíveis".to_owned());
        list.push(gemini);
    }
    list
}

#[tauri::command(async)]
pub fn get_ai_usage() -> Vec<AiUsage> {
    let claude = std::thread::spawn(claude);
    let codex = std::thread::spawn(codex);
    let mut list = Vec::new();
    list.extend(claude.join().ok());
    list.extend(codex.join().ok());
    list.extend(others());
    list.retain(|usage| usage.status != "absent");
    list
}
