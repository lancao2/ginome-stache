//! Agenda: compromissos de calendários publicados em links ICS (o "endereço secreto em
//! formato iCal" do Google Agenda, o link de publicação do Outlook, ou qualquer servidor).
//!
//! As agendas são baixadas a cada 10 minutos; os eventos das próximas 48 horas (inclusive
//! os recorrentes) ficam em memória. Uma thread avisa "começa em 5 minutos" e o frontend
//! mostra o próximo compromisso, o botão de entrar na reunião e os conflitos com tarefas.

use std::{
    collections::HashSet,
    fs,
    str::FromStr,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use chrono::{DateTime, Duration as Span, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use rrule::{RRuleSet, Tz};
use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::tasks::Database;

/// Cores das agendas: cada agenda nova usa a primeira que ainda não está em uso.
const PALETTE: &[&str] = &["#5ab0ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff453a", "#64d2ff", "#ffd60a", "#ff6482"];
const REFRESH: Duration = Duration::from_secs(2 * 60);
const HORIZON_HOURS: i64 = 48;
const WARN_MINUTES: i64 = 5;
const MEETING_HOSTS: &[&str] = &["meet.google.com/", "zoom.us/j/", "zoom.us/my/", "teams.microsoft.com/l/meetup-join", "teams.live.com/meet", "webex.com/meet", "webex.com/join", "whereby.com/", "chime.aws/", "gotomeet.me/"];
/// Nomes de fuso do Windows (usados pelo Outlook) e seus equivalentes IANA.
const WINDOWS_ZONES: &[(&str, &str)] = &[
    ("E. South America Standard Time", "America/Sao_Paulo"),
    ("Argentina Standard Time", "America/Argentina/Buenos_Aires"),
    ("Central Brazilian Standard Time", "America/Cuiaba"),
    ("UTC", "UTC"),
    ("Eastern Standard Time", "America/New_York"),
    ("Central Standard Time", "America/Chicago"),
    ("Mountain Standard Time", "America/Denver"),
    ("Pacific Standard Time", "America/Los_Angeles"),
    ("GMT Standard Time", "Europe/London"),
    ("W. Europe Standard Time", "Europe/Berlin"),
    ("Romance Standard Time", "Europe/Paris"),
    ("Central Europe Standard Time", "Europe/Budapest"),
    ("India Standard Time", "Asia/Kolkata"),
    ("Tokyo Standard Time", "Asia/Tokyo"),
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    uid: String,
    title: String,
    start: i64,
    end: i64,
    all_day: bool,
    location: String,
    /// Descrição do evento (cortada em 1500 caracteres), para a tela de detalhes.
    description: String,
    /// Link da reunião (Meet, Zoom, Teams…), se houver.
    link: Option<String>,
    calendar: String,
    /// Agenda de origem e a cor dela (preenchidas na leitura, para a troca de cor valer na hora).
    source: i64,
    color: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    id: i64,
    name: String,
    /// Só o site do link (o link inteiro é secreto e fica no cofre).
    hint: String,
    /// Cor da agenda (#rrggbb).
    color: String,
}

/// Linha do banco: `url` é "vault:<chave>" (segredo no cofre) ou, em bancos antigos, o link em texto puro.
struct Row {
    id: i64,
    name: String,
    url: String,
    hint: String,
    color: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    text: String,
    at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agenda {
    events: Vec<Event>,
    conflicts: Vec<Conflict>,
    /// Erro da última atualização de cada agenda, se houve.
    errors: Vec<String>,
}

#[derive(Default)]
pub struct Calendar {
    /// Links já lidos do cofre (chave -> link), para não consultar o Keyring a cada atualização.
    secrets: Mutex<std::collections::HashMap<String, String>>,
    /// Último ICS baixado de cada agenda (nome, texto): permite consultar qualquer mês sem baixar de novo.
    texts: Mutex<Vec<(i64, String, String)>>,
    /// Resumo do que foi baixado na última vez: só avisa a tela quando algo mudou.
    signature: Mutex<u64>,
    events: Mutex<Vec<Event>>,
    errors: Mutex<Vec<String>>,
    fetched: Mutex<Option<Instant>>,
}

// --- Leitura do ICS --------------------------------------------------------------------

fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.replace("\r\n", "\n").split('\n') {
        if (raw.starts_with(' ') || raw.starts_with('\t')) && !lines.is_empty() {
            if let Some(last) = lines.last_mut() { last.push_str(&raw[1..]); }
        } else {
            lines.push(raw.to_owned());
        }
    }
    lines
}

fn unescape(text: &str) -> String {
    text.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
}

/// Separa "NOME;param=valor:conteúdo" em (nome, parâmetros, conteúdo).
fn split_line(line: &str) -> Option<(String, Vec<(String, String)>, String)> {
    let colon = line.find(':')?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.to_uppercase();
    let params = parts.filter_map(|part| part.split_once('=')).map(|(key, value)| (key.to_uppercase(), value.trim_matches('"').to_owned())).collect();
    Some((name, params, value.to_owned()))
}

fn zone_name(name: &str) -> String {
    WINDOWS_ZONES.iter().find(|(windows, _)| *windows == name).map_or_else(|| name.to_owned(), |(_, iana)| (*iana).to_owned())
}

/// Converte DTSTART/DTEND em instante UTC; o segundo valor diz se o evento dura o dia todo.
fn parse_time(params: &[(String, String)], value: &str) -> Option<(DateTime<Utc>, bool)> {
    let value = value.trim();
    if value.len() == 8 {
        let date = NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
        let local = Local.from_local_datetime(&date.and_time(NaiveTime::MIN)).earliest()?;
        return Some((local.with_timezone(&Utc), true));
    }
    if let Some(utc) = value.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some((Utc.from_utc_datetime(&naive), false));
    }
    let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?;
    let zone = params.iter().find(|(key, _)| key == "TZID").map(|(_, name)| zone_name(name));
    let instant = match zone.and_then(|name| name.parse::<chrono_tz::Tz>().ok()) {
        Some(tz) => tz.from_local_datetime(&naive).earliest()?.with_timezone(&Utc),
        None => Local.from_local_datetime(&naive).earliest()?.with_timezone(&Utc),
    };
    Some((instant, false))
}

fn meeting_link(texts: &[&str]) -> Option<String> {
    for text in texts {
        for (start, _) in text.match_indices("http") {
            let candidate: String = text[start..].chars().take_while(|ch| !ch.is_whitespace() && !matches!(ch, '<' | '>' | '"' | ')' | '\\')).collect();
            if MEETING_HOSTS.iter().any(|host| candidate.contains(host)) { return Some(candidate); }
        }
    }
    None
}

#[derive(Default)]
struct Raw {
    uid: String,
    summary: String,
    location: String,
    description: String,
    url: String,
    status: String,
    start: Option<(DateTime<Utc>, bool)>,
    end: Option<DateTime<Utc>>,
    /// Linhas DTSTART/RRULE/EXDATE originais, para a expansão das recorrências.
    dtstart: String,
    rrule: String,
    exdates: Vec<String>,
    duration: Option<Span>,
    recurrence_id: bool,
}

fn parse_duration(text: &str) -> Option<Span> {
    let text = text.trim().strip_prefix('P')?;
    let (mut total, mut number) = (0i64, String::new());
    for ch in text.chars() {
        match ch {
            '0'..='9' => number.push(ch),
            'W' => { total += number.parse::<i64>().ok()? * 7 * 86_400; number.clear(); }
            'D' => { total += number.parse::<i64>().ok()? * 86_400; number.clear(); }
            'H' => { total += number.parse::<i64>().ok()? * 3_600; number.clear(); }
            'M' => { total += number.parse::<i64>().ok()? * 60; number.clear(); }
            'S' => { total += number.parse::<i64>().ok()?; number.clear(); }
            _ => {}
        }
    }
    Some(Span::seconds(total))
}

fn rebuild(name: &str, params: &[(String, String)], value: &str) -> String {
    let mut line = name.to_owned();
    for (key, val) in params {
        let val = if key == "TZID" { zone_name(val) } else { val.clone() };
        line.push_str(&format!(";{key}={val}"));
    }
    format!("{line}:{value}")
}

fn parse_events(text: &str, calendar: &str, from: DateTime<Utc>, until: DateTime<Utc>) -> Vec<Event> {
    let mut events = Vec::new();
    let mut current: Option<Raw> = None;
    for line in unfold(text) {
        if line == "BEGIN:VEVENT" { current = Some(Raw::default()); continue; }
        if line == "END:VEVENT" {
            if let Some(raw) = current.take() { expand(raw, calendar, from, until, &mut events); }
            continue;
        }
        let Some(raw) = current.as_mut() else { continue };
        let Some((name, params, value)) = split_line(&line) else { continue };
        match name.as_str() {
            "UID" => raw.uid = value,
            "SUMMARY" => raw.summary = unescape(&value),
            "LOCATION" => raw.location = unescape(&value),
            "DESCRIPTION" => raw.description = unescape(&value),
            "URL" => raw.url = value,
            "STATUS" => raw.status = value.to_uppercase(),
            "RECURRENCE-ID" => raw.recurrence_id = true,
            "DTSTART" => { raw.start = parse_time(&params, &value); raw.dtstart = rebuild("DTSTART", &params, &value); }
            "DTEND" => raw.end = parse_time(&params, &value).map(|(instant, _)| instant),
            "DURATION" => raw.duration = parse_duration(&value),
            "RRULE" => raw.rrule = format!("RRULE:{value}"),
            "EXDATE" => raw.exdates.push(rebuild("EXDATE", &params, &value)),
            _ => {}
        }
    }
    events
}

fn expand(raw: Raw, calendar: &str, from: DateTime<Utc>, until: DateTime<Utc>, out: &mut Vec<Event>) {
    if raw.status == "CANCELLED" { return; }
    let Some((start, all_day)) = raw.start else { return };
    let length = raw.end.map(|end| end - start).or(raw.duration).unwrap_or(if all_day { Span::days(1) } else { Span::zero() });
    let link = meeting_link(&[&raw.url, &raw.location, &raw.description]);
    let make = |start: DateTime<Utc>| Event {
        uid: raw.uid.clone(),
        title: if raw.summary.is_empty() { "(sem título)".to_owned() } else { raw.summary.clone() },
        start: start.timestamp_millis(),
        end: (start + length).timestamp_millis(),
        all_day,
        location: raw.location.clone(),
        description: raw.description.chars().take(1500).collect(),
        link: link.clone(),
        calendar: calendar.to_owned(),
        source: 0,
        color: String::new(),
    };
    let overlaps = |start: DateTime<Utc>| start + length >= from && start <= until;
    if raw.rrule.is_empty() || raw.recurrence_id {
        if overlaps(start) { out.push(make(start)); }
        return;
    }
    let mut text = format!("{}\n{}", raw.dtstart, raw.rrule);
    for exdate in &raw.exdates { text.push('\n'); text.push_str(exdate); }
    let Ok(set) = RRuleSet::from_str(&text) else {
        if overlaps(start) { out.push(make(start)); }
        return;
    };
    let window_start = (from - length).with_timezone(&Tz::UTC);
    let window_end = until.with_timezone(&Tz::UTC);
    for occurrence in set.after(window_start).before(window_end).all(64).dates {
        out.push(make(occurrence.with_timezone(&Utc)));
    }
}

// --- Download --------------------------------------------------------------------------

fn download(url: &str) -> Result<String, String> {
    let url = url.trim();
    if let Some(path) = url.strip_prefix("file://").or_else(|| url.starts_with('/').then_some(url)) {
        return fs::read_to_string(path).map_err(|error| format!("Não consegui ler o arquivo: {error}"));
    }
    let url = url.replacen("webcal://", "https://", 1);
    if !url.starts_with("https://") && !url.starts_with("http://") { return Err("O endereço precisa começar com https://, webcal:// ou ser um arquivo .ics.".to_owned()); }
    let mut response = ureq::get(&url)
        .config()
        .timeout_global(Some(Duration::from_secs(20)))
        .build()
        .header("User-Agent", "Stache/0.1")
        .call()
        .map_err(|error| format!("Não consegui baixar a agenda ({error})."))?;
    let text = response.body_mut().with_config().limit(30_000_000).read_to_string().map_err(|error| format!("Resposta inválida ({error})."))?;
    if !text.contains("BEGIN:VCALENDAR") { return Err("Esse endereço não é uma agenda iCal (.ics).".to_owned()); }
    Ok(text)
}

fn rows(db: &Database) -> Vec<Row> {
    let Ok(connection) = db.lock() else { return Vec::new() };
    let _ = connection.execute_batch("CREATE TABLE IF NOT EXISTS calendar_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE);");
    // Bancos criados antes do cofre não têm a coluna; o erro de coluna repetida é esperado.
    let _ = connection.execute("ALTER TABLE calendar_sources ADD COLUMN hint TEXT NOT NULL DEFAULT ''", []);
    let _ = connection.execute("ALTER TABLE calendar_sources ADD COLUMN color TEXT NOT NULL DEFAULT ''", []);
    let Ok(mut statement) = connection.prepare("SELECT id, name, url, hint, color FROM calendar_sources ORDER BY id") else { return Vec::new() };
    statement.query_map([], |row| {
        let id: i64 = row.get(0)?;
        let color: String = row.get(4)?;
        // Sem cor escolhida, vale a da paleta na posição da agenda.
        let color = if valid_color(&color) { color } else { PALETTE[(id.max(1) as usize - 1) % PALETTE.len()].to_owned() };
        Ok(Row { id, name: row.get(1)?, url: row.get(2)?, hint: row.get(3)?, color })
    }).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

fn valid_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Aplica a cor atual de cada agenda aos eventos (lida do banco, para valer sem baixar de novo).
fn paint(events: &mut [Event], db: &Database) {
    let colors: std::collections::HashMap<i64, String> = rows(db).into_iter().map(|row| (row.id, row.color)).collect();
    for event in events { event.color = colors.get(&event.source).cloned().unwrap_or_else(|| PALETTE[0].to_owned()); }
}

fn sources(db: &Database) -> Vec<Source> {
    rows(db).into_iter().map(|row| Source { id: row.id, name: row.name, hint: if row.hint.is_empty() { host_hint(&row.url) } else { row.hint }, color: row.color }).collect()
}

fn host_hint(url: &str) -> String {
    url::Url::parse(&url.replacen("webcal://", "https://", 1)).ok().and_then(|parsed| parsed.host_str().map(str::to_owned)).unwrap_or_else(|| "agenda".to_owned())
}

/// Identifica o link no cofre sem revelá-lo (hash do endereço).
fn secret_key(url: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// O link da agenda: do cofre (com cache em memória) ou, em bancos antigos, o texto puro.
fn resolve(app: &AppHandle, calendar: &Calendar, row: &Row) -> Result<String, String> {
    let Some(key) = row.url.strip_prefix("vault:") else { return Ok(row.url.clone()) };
    if let Some(url) = calendar.secrets.lock().ok().and_then(|cache| cache.get(key).cloned()) { return Ok(url); }
    let url = crate::vault::get(app, "calendar", key).ok_or("o link não foi encontrado no cofre: remova a agenda e adicione de novo")?;
    if let Ok(mut cache) = calendar.secrets.lock() { cache.insert(key.to_owned(), url.clone()); }
    Ok(url)
}

/// Leva para o cofre os links que bancos antigos guardavam em texto puro.
fn migrate_legacy(app: &AppHandle, db: &Database) {
    for row in rows(db).into_iter().filter(|row| !row.url.starts_with("vault:")) {
        let key = secret_key(&row.url);
        if crate::vault::set(app, "calendar", &key, &row.url).is_err() { continue; }
        let Ok(connection) = db.lock() else { return };
        let _ = connection.execute("UPDATE OR IGNORE calendar_sources SET url = ?1, hint = ?2 WHERE id = ?3", params![format!("vault:{key}"), host_hint(&row.url), row.id]);
    }
}

fn refresh(app: &AppHandle, calendar: &Calendar, db: &Database) {
    let (from, until) = (Utc::now() - Span::hours(2), Utc::now() + Span::hours(HORIZON_HOURS));
    let (mut events, mut errors, mut texts) = (Vec::new(), Vec::new(), Vec::new());
    for row in rows(db) {
        match resolve(app, calendar, &row).and_then(|url| download(&url)) {
            Ok(text) => {
                let mut parsed = parse_events(&text, &row.name, from, until);
                parsed.iter_mut().for_each(|event| event.source = row.id);
                events.extend(parsed);
                texts.push((row.id, row.name.clone(), text));
            }
            Err(error) => errors.push(format!("{}: {error}", row.name)),
        }
    }
    let signature = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        texts.iter().for_each(|(id, _, text)| { id.hash(&mut hasher); text.hash(&mut hasher); });
        errors.hash(&mut hasher);
        hasher.finish()
    };
    if let Ok(mut slot) = calendar.texts.lock() { *slot = texts; }
    events.sort_by_key(|event| event.start);
    if let Ok(mut slot) = calendar.events.lock() { *slot = events; }
    if let Ok(mut slot) = calendar.errors.lock() { *slot = errors; }
    if let Ok(mut slot) = calendar.fetched.lock() { *slot = Some(Instant::now()); }
    // Aviso à tela: um evento novo (ou alterado, ou removido) aparece sem esperar a próxima consulta.
    let changed = calendar.signature.lock().map(|mut last| { let changed = *last != signature; *last = signature; changed }).unwrap_or(true);
    if changed { let _ = app.emit("calendar-updated", ()); }
}

// --- Conflitos -------------------------------------------------------------------------

fn clock(millis: i64) -> String {
    Local.timestamp_millis_opt(millis).single().map(|time| time.format("%H:%M").to_string()).unwrap_or_default()
}

fn task_times(db: &Database) -> Vec<(String, i64)> {
    let Ok(connection) = db.lock() else { return Vec::new() };
    let Ok(mut statement) = connection.prepare("SELECT title, due_date, due_time FROM tasks WHERE done = 0 AND due_date IS NOT NULL AND due_time IS NOT NULL") else { return Vec::new() };
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)));
    rows.map(|rows| rows.flatten().filter_map(|(title, date, time)| {
        let naive = NaiveDateTime::parse_from_str(&format!("{date} {time}"), "%Y-%m-%d %H:%M").ok()?;
        Some((title, Local.from_local_datetime(&naive).earliest()?.timestamp_millis()))
    }).collect()).unwrap_or_default()
}

fn conflicts(events: &[Event], tasks: &[(String, i64)]) -> Vec<Conflict> {
    let timed: Vec<&Event> = events.iter().filter(|event| !event.all_day && event.end > event.start).collect();
    let mut found = Vec::new();
    for (index, first) in timed.iter().enumerate() {
        for second in &timed[index + 1..] {
            if first.start < second.end && second.start < first.end {
                found.push(Conflict { text: format!("“{}” e “{}” se sobrepõem", first.title, second.title), at: first.start.max(second.start) });
            }
        }
        for (title, at) in tasks {
            if *at >= first.start && *at < first.end {
                found.push(Conflict { text: format!("Tarefa “{title}” ({}) cai em “{}” ({}–{})", clock(*at), first.title, clock(first.start), clock(first.end)), at: *at });
            }
        }
    }
    found.sort_by_key(|conflict| conflict.at);
    found
}

fn agenda(calendar: &Calendar, db: &Database) -> Agenda {
    let now = Utc::now().timestamp_millis();
    let mut events: Vec<Event> = calendar.events.lock().map(|list| list.iter().filter(|event| event.end >= now || (event.end == event.start && event.start >= now - 60_000)).cloned().collect()).unwrap_or_default();
    paint(&mut events, db);
    let conflicts = conflicts(&events, &task_times(db));
    Agenda { events, conflicts, errors: calendar.errors.lock().map(|list| list.clone()).unwrap_or_default() }
}

// --- Comandos --------------------------------------------------------------------------

#[tauri::command(async)]
pub fn calendar_agenda(app: AppHandle, calendar: State<Arc<Calendar>>, db: State<Database>, force: Option<bool>) -> Agenda {
    let stale = calendar.fetched.lock().map(|at| at.is_none_or(|at| at.elapsed() > REFRESH)).unwrap_or(true);
    // `force` é o botão "atualizar agora": baixa as agendas de novo, mesmo que o último download seja recente.
    if stale || force == Some(true) { refresh(&app, &calendar, &db); }
    agenda(&calendar, &db)
}

/// Compromissos (inclusive os de dia inteiro, como feriados) entre duas datas, para o calendário do mês.
#[tauri::command(async)]
pub fn calendar_range(calendar: State<Arc<Calendar>>, db: State<Database>, from: i64, to: i64) -> Vec<Event> {
    // Limita a consulta a ~100 dias para a expansão de recorrências continuar barata.
    let (Some(start), Some(end)) = (Utc.timestamp_millis_opt(from).single(), Utc.timestamp_millis_opt(to.min(from + 100 * 86_400_000)).single()) else { return Vec::new() };
    let texts = calendar.texts.lock().map(|list| list.clone()).unwrap_or_default();
    let mut events: Vec<Event> = texts.iter().flat_map(|(id, name, text)| {
        let mut parsed = parse_events(text, name, start, end);
        parsed.iter_mut().for_each(|event| event.source = *id);
        parsed
    }).collect();
    events.sort_by_key(|event| event.start);
    paint(&mut events, &db);
    events
}

#[tauri::command]
pub fn calendar_sources(db: State<Database>) -> Vec<Source> { sources(&db) }

#[tauri::command(async)]
pub fn calendar_add(app: AppHandle, calendar: State<Arc<Calendar>>, db: State<Database>, name: String, url: String, color: Option<String>) -> Result<String, String> {
    let (name, url) = (name.trim().to_owned(), url.trim().to_owned());
    if url.is_empty() { return Err("Cole o endereço da agenda.".to_owned()); }
    // Só salva se o endereço realmente devolve uma agenda.
    download(&url)?;
    let name = if name.is_empty() { "Agenda".to_owned() } else { name };
    // O link é um segredo (quem o tem lê a agenda): vai para o cofre; o banco guarda só a referência.
    let key = secret_key(&url);
    let backend = crate::vault::set(&app, "calendar", &key, &url)?;
    {
        let connection = db.lock()?;
        let _ = rows_table(&connection);
        // Sem cor escolhida, a agenda nova pega a primeira cor da paleta que ninguém usa.
        let used: Vec<String> = connection.prepare("SELECT color FROM calendar_sources").and_then(|mut statement| statement.query_map([], |row| row.get::<_, String>(0)).map(|list| list.flatten().collect())).unwrap_or_default();
        let color = color.filter(|color| valid_color(color)).or_else(|| PALETTE.iter().find(|candidate| !used.iter().any(|taken| taken.eq_ignore_ascii_case(candidate))).map(|color| (*color).to_owned())).unwrap_or_default();
        connection.execute("INSERT OR REPLACE INTO calendar_sources (name, url, hint, color) VALUES (?1, ?2, ?3, ?4)", params![name, format!("vault:{key}"), host_hint(&url), color]).map_err(|error| error.to_string())?;
    }
    if let Ok(mut cache) = calendar.secrets.lock() { cache.insert(key, url); }
    refresh(&app, &calendar, &db);
    Ok(match backend { crate::vault::Backend::Keyring => "keyring", crate::vault::Backend::File => "file" }.to_owned())
}

fn rows_table(connection: &rusqlite::Connection) -> rusqlite::Result<()> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS calendar_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE);")?;
    let _ = connection.execute("ALTER TABLE calendar_sources ADD COLUMN hint TEXT NOT NULL DEFAULT ''", []);
    let _ = connection.execute("ALTER TABLE calendar_sources ADD COLUMN color TEXT NOT NULL DEFAULT ''", []);
    Ok(())
}

/// Troca a cor de uma agenda (#rrggbb). Vale na hora: as cores são aplicadas na leitura.
#[tauri::command]
pub fn calendar_set_color(db: State<Database>, id: i64, color: String) -> Result<(), String> {
    if !valid_color(&color) { return Err("cor inválida".to_owned()); }
    db.lock()?.execute("UPDATE calendar_sources SET color = ?1 WHERE id = ?2", params![color.to_lowercase(), id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn calendar_remove(app: AppHandle, calendar: State<Arc<Calendar>>, db: State<Database>, id: i64) -> Result<(), String> {
    let url: Option<String> = db.lock()?.query_row("SELECT url FROM calendar_sources WHERE id = ?1", params![id], |row| row.get(0)).ok();
    db.lock()?.execute("DELETE FROM calendar_sources WHERE id = ?1", params![id]).map_err(|error| error.to_string())?;
    if let Some(key) = url.as_deref().and_then(|url| url.strip_prefix("vault:")) {
        crate::vault::delete(&app, "calendar", key);
        if let Ok(mut cache) = calendar.secrets.lock() { cache.remove(key); }
    }
    refresh(&app, &calendar, &db);
    Ok(())
}

// --- Avisos ----------------------------------------------------------------------------

/// Verifica a cada 20 s: "começa em 5 minutos", "começa agora" e conflitos novos.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut warned: HashSet<String> = HashSet::new();
        // Migra os links antigos (texto puro) para o cofre assim que o banco estiver pronto.
        thread::sleep(Duration::from_secs(3));
        crate::session::wait_unlocked();
        if let Some(db) = app.try_state::<Database>() { migrate_legacy(&app, &db); }
        loop {
            thread::sleep(Duration::from_secs(20));
            // Bloqueada a tela, nada de baixar agendas nem mexer no cofre.
            if crate::session::locked() { continue; }
            let (Some(calendar), Some(db)) = (app.try_state::<Arc<Calendar>>(), app.try_state::<Database>()) else { continue };
            let stale = calendar.fetched.lock().map(|at| at.is_none_or(|at| at.elapsed() > REFRESH)).unwrap_or(true);
            if stale { refresh(&app, &calendar, &db); }
            let now = Utc::now().timestamp_millis();
            let current = agenda(&calendar, &db);
            for event in current.events.iter().filter(|event| !event.all_day) {
                let minutes = (event.start - now + 59_999).div_euclid(60_000);
                let key = |kind: &str| format!("{kind}:{}:{}", event.uid, event.start);
                if (1..=WARN_MINUTES).contains(&minutes) && warned.insert(key("soon")) {
                    let label = format!("Começa em {minutes} min");
                    emit(&app, "meeting", &label, &event.title, "normal", &event.link);
                } else if (-1..=0).contains(&minutes) && warned.insert(key("now")) {
                    emit(&app, "meeting", "Começa agora", &event.title, "warning", &event.link);
                }
            }
            for conflict in current.conflicts.iter().filter(|conflict| conflict.at - now < 24 * 3_600_000) {
                if warned.insert(format!("conflict:{}:{}", conflict.text, conflict.at)) {
                    emit(&app, "conflict", "Conflito de agenda", &conflict.text, "warning", &None);
                }
            }
            if warned.len() > 500 { warned.clear(); }
        }
    });
}

fn emit(app: &AppHandle, kind: &str, label: &str, text: &str, tone: &str, link: &Option<String>) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload { kind: String, label: String, text: String, tone: String, action: String, path: Option<String> }
    let _ = app.emit("context-event", Payload {
        kind: kind.to_owned(),
        label: label.to_owned(),
        text: text.to_owned(),
        tone: tone.to_owned(),
        action: if link.is_some() { "url" } else { "none" }.to_owned(),
        path: link.clone(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1\r\nSUMMARY:Reunião diária\r\nDTSTART;TZID=America/Sao_Paulo:20261012T100000\r\nDTEND;TZID=America/Sao_Paulo:20261012T103000\r\nRRULE:FREQ=DAILY;COUNT=5\r\nDESCRIPTION:Entre em https://meet.google.com/abc-defg-hij\\nobrigado\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b2\r\nSUMMARY:Almoço\r\nDTSTART:20261012T130000Z\r\nDTEND:20261012T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn reads_events_and_recurrences() {
        let from = Utc.with_ymd_and_hms(2026, 10, 12, 0, 0, 0).unwrap();
        let events = parse_events(SAMPLE, "Teste", from, from + Span::hours(48));
        let titles: Vec<_> = events.iter().map(|event| event.title.as_str()).collect();
        assert!(titles.iter().filter(|title| **title == "Reunião diária").count() >= 2, "{titles:?}");
        let daily = events.iter().find(|event| event.title == "Reunião diária").unwrap();
        assert_eq!(daily.link.as_deref(), Some("https://meet.google.com/abc-defg-hij"));
        // 10:00 em São Paulo (UTC-3) = 13:00 UTC.
        assert_eq!(daily.start, Utc.with_ymd_and_hms(2026, 10, 12, 13, 0, 0).unwrap().timestamp_millis());
        assert_eq!(daily.end - daily.start, 30 * 60_000);
    }

    #[test]
    #[ignore]
    fn live_public_calendar() {
        let url = "https://calendar.google.com/calendar/ical/pt.brazilian%23holiday%40group.v.calendar.google.com/public/basic.ics";
        let text = download(url).expect("baixar");
        let from = Utc::now();
        let events = parse_events(&text, "Feriados", from, from + Span::days(90));
        for event in events.iter().take(5) { println!("{} | all_day={} | {}", event.title, event.all_day, clock(event.start)); }
        assert!(!events.is_empty());
    }

    #[test]
    fn finds_overlap() {
        let event = |title: &str, start: i64, end: i64| Event { uid: title.into(), title: title.into(), start, end, all_day: false, location: String::new(), description: String::new(), link: None, calendar: String::new(), source: 0, color: String::new() };
        let list = vec![event("A", 0, 60_000 * 60), event("B", 60_000 * 30, 60_000 * 90), event("C", 60_000 * 120, 60_000 * 150)];
        assert_eq!(conflicts(&list, &[("Tarefa".into(), 60_000 * 125)]).len(), 2);
    }
}
