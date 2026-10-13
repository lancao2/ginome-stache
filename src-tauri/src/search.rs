//! Busca de arquivos e pastas em todo o computador (Super+Espaço).
//!
//! Um índice só com os caminhos fica em memória (um bloco contíguo de bytes, ~60 MB para
//! ~1 milhão de itens). Ele é montado em segundo plano, com prioridade baixa, na primeira
//! vez que a busca é aberta e reconstruído se tiver mais de alguns minutos; repouso custa zero.

use std::{
    collections::BinaryHeap,
    fs,
    path::Path,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex, RwLock,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const MAX_RESULTS: usize = 60;
const STALE_AFTER: Duration = Duration::from_secs(10 * 60);
/// Pastas que só têm ruído (dependências, caches) em qualquer lugar do disco.
const SKIP_NAMES: &[&str] = &["node_modules", ".git", ".cache", "__pycache__", ".npm", ".pnpm-store"];
/// Sistemas de arquivos virtuais e áreas que não são arquivos do usuário.
const SKIP_PATHS: &[&str] = &["/proc", "/sys", "/dev", "/run", "/snap", "/var/lib/snapd", "/var/cache", "/lost+found"];

struct Entry {
    start: u32,
    len: u16,
    /// Onde começa o nome dentro do caminho.
    name: u16,
    dir: bool,
    /// Fora das áreas do usuário (sistema, pastas ocultas): só aparece em buscas `%termo%`.
    system: bool,
}

/// Áreas que um usuário comum navega: pastas visíveis em /home, /media e /mnt.
fn is_system(path: &str) -> bool {
    let user_area = ["/home/", "/media/", "/mnt/"].iter().any(|root| path.starts_with(root));
    !user_area || path.contains("/.")
}

#[derive(Default)]
struct Index {
    data: Vec<u8>,
    entries: Vec<Entry>,
    built: Option<Instant>,
}

impl Index {
    fn push(&mut self, path: &str, dir: bool) {
        let bytes = path.as_bytes();
        if bytes.len() > u16::MAX as usize || self.data.len() + bytes.len() > u32::MAX as usize {
            return;
        }
        let name = bytes.iter().rposition(|&byte| byte == b'/').map_or(0, |index| index + 1);
        self.entries.push(Entry { start: self.data.len() as u32, len: bytes.len() as u16, name: name as u16, dir, system: is_system(path) });
        self.data.extend_from_slice(bytes);
    }

    fn path(&self, entry: &Entry) -> &str {
        let start = entry.start as usize;
        std::str::from_utf8(&self.data[start..start + entry.len as usize]).unwrap_or("")
    }
}

#[derive(Default)]
pub struct Search {
    index: RwLock<Arc<Index>>,
    building: Mutex<bool>,
    /// Itens já encontrados pela indexação em andamento (para mostrar progresso).
    progress: AtomicUsize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    path: String,
    name: String,
    dir: bool,
}

impl Hit {
    pub fn folder(path: String) -> Self {
        let name = path.rsplit('/').next().unwrap_or("").to_owned();
        Hit { path, name, dir: true }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    ready: bool,
    building: bool,
    count: usize,
}

/// Fila de pastas compartilhada entre as threads que percorrem o disco.
struct Walker {
    queue: Mutex<Vec<PathBuf>>,
    wake: Condvar,
    /// Pastas na fila ou sendo lidas; chega a zero quando o disco todo foi percorrido.
    pending: AtomicUsize,
    found: AtomicUsize,
    done: AtomicBool,
}

impl Walker {
    fn worker(&self) -> Index {
        lower_priority();
        let mut index = Index::default();
        loop {
            let dir = {
                let Ok(mut queue) = self.queue.lock() else { break };
                loop {
                    if let Some(dir) = queue.pop() { break Some(dir); }
                    if self.pending.load(Ordering::SeqCst) == 0 { break None; }
                    queue = match self.wake.wait(queue) { Ok(queue) => queue, Err(_) => break None };
                }
            };
            let Some(dir) = dir else { break };
            let mut subdirs = Vec::new();
            if let Ok(read) = fs::read_dir(&dir) {
                for entry in read.flatten() {
                    let Ok(kind) = entry.file_type() else { continue };
                    let path = entry.path();
                    let Some(text) = path.to_str() else { continue };
                    // Links simbólicos entram como arquivos, mas nunca são seguidos (evita ciclos).
                    let is_dir = kind.is_dir();
                    if is_dir {
                        let name = entry.file_name();
                        if name.to_str().is_some_and(|name| SKIP_NAMES.contains(&name)) || SKIP_PATHS.contains(&text) {
                            continue;
                        }
                        subdirs.push(path.clone());
                    }
                    index.push(text, is_dir);
                    self.found.fetch_add(1, Ordering::Relaxed);
                }
            }
            if !subdirs.is_empty() {
                self.pending.fetch_add(subdirs.len(), Ordering::SeqCst);
                if let Ok(mut queue) = self.queue.lock() { queue.extend(subdirs); }
                self.wake.notify_all();
            }
            if self.pending.fetch_sub(1, Ordering::SeqCst) == 1 {
                // Segura o lock para que nenhuma thread perca o aviso antes de dormir.
                let _guard = self.queue.lock();
                self.done.store(true, Ordering::SeqCst);
                self.wake.notify_all();
            }
        }
        index
    }
}

/// Percorre o disco com várias threads e junta os pedaços num único índice.
/// Enquanto trabalha, avisa o frontend do andamento a cada instante.
fn walk(search: &Search, app: Option<&AppHandle>) -> Index {
    let walker = Walker {
        queue: Mutex::new(vec![PathBuf::from("/")]),
        wake: Condvar::new(),
        pending: AtomicUsize::new(1),
        found: AtomicUsize::new(0),
        done: AtomicBool::new(false),
    };
    let threads = std::thread::available_parallelism().map_or(4, |count| count.get()).clamp(2, 6);
    let parts: Vec<Index> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads).map(|_| scope.spawn(|| walker.worker())).collect();
        while !walker.done.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
            let found = walker.found.load(Ordering::Relaxed);
            search.progress.store(found, Ordering::Relaxed);
            if let Some(app) = app {
                let _ = app.emit("search-index-progress", Status { ready: false, building: true, count: found });
            }
        }
        workers.into_iter().filter_map(|worker| worker.join().ok()).collect()
    });
    let mut merged = Index::default();
    for part in parts {
        let base = merged.data.len();
        if base + part.data.len() > u32::MAX as usize { break; }
        merged.data.extend_from_slice(&part.data);
        merged.entries.extend(part.entries.into_iter().map(|entry| Entry { start: entry.start + base as u32, ..entry }));
    }
    merged
}

/// Prioridade baixa para a thread atual: a indexação não atrapalha o resto do sistema.
fn lower_priority() {
    #[cfg(target_os = "linux")]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, 10);
    }
}

fn status(search: &Search) -> Status {
    let index = search.index.read().map(|index| index.clone()).unwrap_or_default();
    let building = search.building.lock().map(|flag| *flag).unwrap_or(false);
    Status {
        ready: index.built.is_some(),
        building,
        count: if building { search.progress.load(Ordering::Relaxed) } else { index.entries.len() },
    }
}

/// Começa a indexar em segundo plano se ainda não há índice ou ele está velho.
#[tauri::command]
pub fn search_prepare(app: AppHandle, search: State<Arc<Search>>) -> Status {
    let stale = search.index.read().map(|index| index.built.is_none_or(|built| built.elapsed() > STALE_AFTER)).unwrap_or(true);
    if stale {
        let Ok(mut building) = search.building.lock() else { return status(&search) };
        if !*building {
            *building = true;
            drop(building);
            search.progress.store(0, Ordering::Relaxed);
            let shared = search.inner().clone();
            std::thread::spawn(move || {
                let mut fresh = walk(&shared, Some(&app));
                fresh.data.shrink_to_fit();
                fresh.entries.shrink_to_fit();
                fresh.built = Some(Instant::now());
                if let Ok(mut slot) = shared.index.write() { *slot = Arc::new(fresh); }
                if let Ok(mut flag) = shared.building.lock() { *flag = false; }
                let _ = app.emit("search-index-ready", status(&shared));
            });
        }
    }
    status(&search)
}

/// Comparação sem diferenciar maiúsculas, sem alocar, para consultas ASCII.
fn find_ascii(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    let first = needle[0];
    let last = haystack.len().checked_sub(needle.len())?;
    (0..=last).find(|&start| {
        haystack[start].to_ascii_lowercase() == first
            && haystack[start + 1..start + needle.len()].iter().zip(&needle[1..]).all(|(a, b)| a.to_ascii_lowercase() == *b)
    })
}

fn find(haystack: &[u8], needle: &[u8], ascii: bool) -> Option<usize> {
    if ascii { return find_ascii(haystack, needle); }
    // Consulta com acentos: compara em minúsculas Unicode.
    let lowered = String::from_utf8_lossy(haystack).to_lowercase();
    lowered.find(std::str::from_utf8(needle).unwrap_or("")).map(|at| at.min(haystack.len().saturating_sub(1)))
}

/// Menor é melhor: nome igual, começa com, início de palavra, contém, termos extras no caminho.
fn score(path: &[u8], name_at: usize, terms: &[Vec<u8>], ascii: bool) -> Option<u32> {
    let name = &path[name_at..];
    let mut best = 0u32;
    let mut in_name = true;
    let mut any_in_name = false;
    for term in terms {
        match find(name, term, ascii) {
            Some(at) => {
                let rank = if name.len() == term.len() { 0 }
                    else if at == 0 { 1 }
                    else if !name[at - 1].is_ascii_alphanumeric() { 2 }
                    else { 3 };
                best = best.max(rank);
                any_in_name = true;
            }
            None => {
                find(path, term, ascii)?;
                in_name = false;
            }
        }
    }
    // Pelo menos um termo precisa estar no nome: o que só está numa pasta acima não é resultado.
    // Os demais termos podem estar no caminho ("natuhair fotos" acha "fotos" dentro de Natuhair).
    if !any_in_name { return None; }
    if !in_name { best = best.max(4); }
    // Itens em pastas ocultas (.config, .local…) ficam depois dos demais.
    if path.windows(2).any(|pair| pair == b"/.") { best += 10; }
    Some(best)
}

#[tauri::command(async)]
pub fn search_query(search: State<Arc<Search>>, query: String) -> Vec<Hit> {
    // %termo%: inclui também os itens do sistema, que a busca normal esconde.
    let trimmed = query.trim();
    let deep = trimmed.len() > 1 && trimmed.starts_with('%') && trimmed.ends_with('%');
    let query = trimmed.trim_matches('%').to_owned();
    let terms: Vec<Vec<u8>> = query.to_lowercase().split_whitespace().map(|term| term.as_bytes().to_vec()).collect();
    if terms.is_empty() { return Vec::new(); }
    let ascii = terms.iter().all(|term| term.is_ascii());
    let index = search.index.read().map(|index| index.clone()).unwrap_or_default();

    // Cada thread varre um pedaço e guarda só os melhores: (nota, pasta antes de arquivo, caminho curto primeiro).
    let threads = std::thread::available_parallelism().map_or(2, |count| count.get()).clamp(1, 8);
    let chunk = index.entries.len().div_ceil(threads).max(1);
    let scan = |from: usize, entries: &[Entry]| {
        let mut best: BinaryHeap<(u32, u8, usize, usize)> = BinaryHeap::with_capacity(MAX_RESULTS + 1);
        for (offset, entry) in entries.iter().enumerate() {
            let start = entry.start as usize;
            if entry.system && !deep { continue; }
            let path = &index.data[start..start + entry.len as usize];
            let Some(points) = score(path, entry.name as usize, &terms, ascii) else { continue };
            let key = (points, u8::from(!entry.dir), path.len(), from + offset);
            if best.len() < MAX_RESULTS { best.push(key); }
            else if best.peek().is_some_and(|worst| key < *worst) { best.pop(); best.push(key); }
        }
        best.into_vec()
    };
    let mut merged: Vec<(u32, u8, usize, usize)> = std::thread::scope(|scope| {
        let handles: Vec<_> = index.entries.chunks(chunk).enumerate()
            .map(|(number, entries)| scope.spawn(move || scan(number * chunk, entries)))
            .collect();
        handles.into_iter().filter_map(|handle| handle.join().ok()).flatten().collect()
    });
    merged.sort();
    merged.truncate(MAX_RESULTS);
    let best = BinaryHeap::from(merged);
    let mut ranked = best.into_vec();
    ranked.sort();
    ranked
        .into_iter()
        .map(|(_, _, _, id)| {
            let entry = &index.entries[id];
            let path = index.path(entry);
            Hit { path: path.to_owned(), name: path[entry.name as usize..].to_owned(), dir: entry.dir }
        })
        .collect()
}

/// Abre o arquivo ou pasta com o programa padrão; `reveal` abre a pasta que o contém.
#[tauri::command]
pub fn search_open(app: AppHandle, path: String, reveal: bool) -> Result<(), String> {
    let target = if reveal { Path::new(&path).parent().map(Path::to_path_buf).unwrap_or_default() } else { path.into() };
    if !target.exists() { return Err("Este item não existe mais.".to_owned()); }
    if target.is_dir() { if let Some(text) = target.to_str() { crate::suggest::record(&app, "dir", text); } }
    Command::new("xdg-open")
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Não consegui abrir: {error}"))
}

/// Pesquisa o texto na web, abrindo o navegador padrão.
#[tauri::command]
pub fn search_web(query: String) -> Result<(), String> {
    let url = url::Url::parse_with_params("https://www.google.com/search", [("q", query.trim())]).map_err(|error| error.to_string())?;
    Command::new("xdg-open")
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Não consegui abrir o navegador: {error}"))
}

#[cfg(target_os = "linux")]
pub fn start(app: AppHandle) {
    crate::clipboard::extension::listen(app, "SearchShortcut", |app, _| { let _ = app.emit("search-shortcut", ()); });
}
#[cfg(not(target_os = "linux"))]
pub fn start(_app: AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn bench() {
        let t = Instant::now();
        let search = Search::default();
        let index = walk(&search, None);
        println!("indexed {} entries, {} MB, in {:?}", index.entries.len(), index.data.len() / 1_000_000, t.elapsed());
        let terms = vec![b"readme".to_vec()];
        let t = Instant::now();
        let n = index.entries.iter().filter(|e| {
            let p = &index.data[e.start as usize..e.start as usize + e.len as usize];
            score(p, e.name as usize, &terms, true).is_some()
        }).count();
        println!("query: {n} matches in {:?}", t.elapsed());
    }
}
