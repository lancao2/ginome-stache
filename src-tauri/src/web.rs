//! Os primeiros sites de uma pesquisa na web, para mostrar na busca da ilha.
//!
//! Lê a página de resultados do Bing e, se ela falhar, a do DuckDuckGo (o Google não oferece
//! resultados sem chave de API e bloqueia consultas automáticas). Os ícones vêm do serviço de favicons e voltam como
//! data URI, para a interface não depender de rede nem de permissões de imagem externa.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;

const SITES: usize = 3;
const AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    title: String,
    url: String,
    host: String,
    /// Favicon como data URI; vazio se não foi possível baixar.
    icon: String,
}

fn get(url: &str, timeout: u64) -> Option<ureq::http::Response<ureq::Body>> {
    ureq::get(url)
        .config()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .build()
        .header("User-Agent", AGENT)
        .header("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.5")
        .call()
        .ok()
}

fn decode_percent(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() && text.is_char_boundary(at + 1) && text.is_char_boundary(at + 3) {
            if let Ok(value) = u8::from_str_radix(&text[at + 1..at + 3], 16) {
                out.push(value);
                at += 3;
                continue;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let decoded = rest.find(';').filter(|end| *end <= 8).and_then(|end| {
            let entity = &rest[1..end];
            let ch = match entity {
                "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'), "quot" => Some('"'), "apos" => Some('\''),
                _ => entity.strip_prefix('#').and_then(|number| match number.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => number.parse().ok(),
                }).and_then(char::from_u32),
            };
            ch.map(|ch| (ch, end))
        });
        match decoded {
            Some((ch, end)) => { out.push(ch); rest = &rest[end + 1..]; }
            None => { out.push('&'); rest = &rest[1..]; }
        }
    }
    out.push_str(rest);
    out
}

/// Remove marcações como <b>…</b> do título.
fn strip_tags(text: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for ch in text.chars() {
        match ch { '<' => inside = true, '>' => inside = false, _ if !inside => out.push(ch), _ => {} }
    }
    out
}

fn parse(html: &str) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = Vec::new();
    for chunk in html.split("class=\"result__a\"").skip(1) {
        let Some(href) = chunk.split("href=\"").nth(1).and_then(|rest| rest.split('"').next()) else { continue };
        // Anúncios passam por outro redirecionador, sem o endereço final.
        let Some(target) = href.split("uddg=").nth(1).and_then(|rest| rest.split('&').next()) else { continue };
        let url = decode_percent(target);
        if !url.starts_with("http") { continue; }
        let title = chunk.split_once('>').and_then(|(_, rest)| rest.split("</a>").next()).map(|raw| unescape(&strip_tags(raw)).trim().to_owned()).unwrap_or_default();
        let host = host_of(&url);
        // Um resultado por site: páginas diferentes do mesmo domínio não repetem.
        if found.iter().any(|(_, known)| host_of(known) == host) { continue; }
        found.push((title, url));
        if found.len() == SITES { break; }
    }
    found
}

/// Resultados do Bing: o endereço final vem em `u=a1<base64>` dentro do link de redirecionamento.
fn parse_bing(html: &str) -> Vec<(String, String)> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut found: Vec<(String, String)> = Vec::new();
    for chunk in html.split("<li class=\"b_algo\"").skip(1) {
        let Some(heading) = chunk.split("<h2").nth(1) else { continue };
        let Some(href) = heading.split("href=\"").nth(1).and_then(|rest| rest.split('"').next()) else { continue };
        let href = unescape(href);
        let url = if let Some(encoded) = href.split("&u=a1").nth(1).and_then(|rest| rest.split('&').next()) {
            match URL_SAFE_NO_PAD.decode(encoded.trim_end_matches('=')).ok().and_then(|bytes| String::from_utf8(bytes).ok()) {
                Some(url) => url,
                None => continue,
            }
        } else { href };
        if !url.starts_with("http") || url.contains("bing.com/") { continue; }
        let title = heading.split_once('>').and_then(|(_, rest)| rest.split_once("</a>")).and_then(|(inner, _)| inner.split_once('>').map(|(_, text)| text))
            .map(|raw| unescape(&strip_tags(raw)).trim().to_owned()).unwrap_or_default();
        if found.iter().any(|(_, known)| host_of(known) == host_of(&url)) { continue; }
        found.push((title, url));
        if found.len() == SITES { break; }
    }
    found
}

fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|parsed| parsed.host_str().map(|host| host.trim_start_matches("www.").to_owned())).unwrap_or_default()
}

fn fetch_icon(url: &str) -> Option<String> {
    let mut response = get(url, 6)?;
    let mime = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").to_owned();
    // Alguns sites servem o .ico sem tipo; o navegador aceita image/x-icon nesse caso.
    let mime = if mime.starts_with("image/") { mime } else if url.ends_with(".ico") { "image/x-icon".to_owned() } else { return None };
    let bytes = response.body_mut().with_config().limit(200_000).read_to_vec().ok()?;
    (!bytes.is_empty()).then(|| format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Ícone do site: primeiro o serviço de favicons; se não tiver, o /favicon.ico do próprio site.
fn favicon(host: &str) -> String {
    fetch_icon(&format!("https://www.google.com/s2/favicons?domain={host}&sz=64"))
        .or_else(|| fetch_icon(&format!("https://{host}/favicon.ico")))
        .unwrap_or_default()
}

#[tauri::command(async)]
pub fn search_web_sites(query: String) -> Vec<Site> {
    let query = query.trim();
    if query.is_empty() { return Vec::new(); }
    let fetch = |base: &str, params: &[(&str, &str)]| {
        let page = url::Url::parse_with_params(base, params).ok()?;
        get(page.as_str(), 8)?.body_mut().read_to_string().ok()
    };
    let mut hits = fetch("https://www.bing.com/search", &[("q", query), ("setlang", "pt-BR"), ("cc", "BR")]).map(|html| parse_bing(&html)).unwrap_or_default();
    if hits.is_empty() {
        hits = fetch("https://html.duckduckgo.com/html/", &[("q", query)]).map(|html| parse(&html)).unwrap_or_default();
    }
    // Os ícones são baixados ao mesmo tempo.
    std::thread::scope(|scope| {
        let handles: Vec<_> = hits.iter().map(|(_, url)| { let host = host_of(url); scope.spawn(move || favicon(&host)) }).collect();
        hits.iter().zip(handles).map(|((title, url), handle)| {
            let host = host_of(url);
            Site { title: if title.is_empty() { host.clone() } else { title.clone() }, url: url.clone(), icon: handle.join().unwrap_or_default(), host }
        }).collect()
    })
}

/// Abre o endereço no navegador padrão.
#[tauri::command]
pub fn search_open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) { return Err("Endereço inválido.".to_owned()); }
    let mut child = std::process::Command::new("xdg-open")
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("Não consegui abrir o navegador: {error}"))?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn live() {
        let sites = super::search_web_sites("faculdade".to_owned());
        for site in &sites { println!("{} | {} | {} | icon {} bytes", site.title, site.url, site.host, site.icon.len()); }
        assert_eq!(sites.len(), 3);
        assert!(sites.iter().all(|site| !site.icon.is_empty()));
    }
}
