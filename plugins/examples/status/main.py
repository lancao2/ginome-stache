import time
from urllib.parse import urlparse

import stache

known = {}


def refresh():
    urls = [u.strip() for u in stache.settings().get("urls", "https://example.com").split(",") if u.strip()]
    lines = []
    for url in urls[:8]:
        answer = stache.http_get(url, head=True)
        status = answer.get("status") or 0
        online = bool(answer.get("ok")) and 0 < status < 500
        host = urlparse(url).netloc or url
        if host in known and known[host] != online:
            stache.alert("Servidor", f"{host} " + ("voltou" if online else "caiu"), tone="success" if online else "warning", url=url)
        known[host] = online
        text = f'{status} · {answer.get("elapsed_ms", 0)} ms' if online else (answer.get("error") or f"HTTP {status}")
        lines.append((host, text, "success" if online else "danger"))
    stache.card("status", "Servidores", subtitle="Atualizado " + time.strftime("%H:%M:%S"), lines=lines or [("Nenhum endereço", "configure em Ajustes")])


def main():
    while True:
        try:
            refresh()
        except Exception as error:  # noqa: BLE001
            stache.card("status", "Servidores", body=f"Erro: {error}")
        time.sleep(30)


stache.run(main)
