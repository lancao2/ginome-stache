import json
import os
import time

import stache

STATE = "/data/last_release.txt"


def last_seen():
    try:
        return open(STATE).read().strip()
    except OSError:
        return ""


def refresh():
    repo = stache.settings().get("repo", "tauri-apps/tauri").strip()
    headers = {"Accept": "application/vnd.github+json"}
    token = stache.settings().get("token", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    info = stache.http_get(f"https://api.github.com/repos/{repo}", headers=headers)
    if info.get("status") != 200:
        stache.card("repo", "GitHub", body=f"{repo}: sem dados ({info.get('status') or info.get('error')})")
        return
    data = json.loads(info["body"])
    lines = [("Estrelas", f'{data["stargazers_count"]:,}'.replace(",", ".")),
             ("Forks", f'{data["forks_count"]:,}'.replace(",", ".")),
             ("Issues abertas", str(data["open_issues_count"]))]
    release = stache.http_get(f"https://api.github.com/repos/{repo}/releases/latest", headers=headers)
    if release.get("status") == 200:
        tag = json.loads(release["body"]).get("tag_name", "")
        lines.append(("Última versão", tag, "success"))
        if tag and last_seen() and tag != last_seen():
            stache.alert("GitHub", f"{repo} {tag}", tone="success", url=f"https://github.com/{repo}/releases/tag/{tag}")
        if tag and tag != last_seen():
            os.makedirs("/data", exist_ok=True)
            open(STATE, "w").write(tag)
    stache.card("repo", repo, subtitle="GitHub", lines=lines, url=data.get("html_url"))


def main():
    while True:
        try:
            refresh()
        except Exception as error:  # noqa: BLE001
            stache.card("repo", "GitHub", body=f"Erro: {error}")
        time.sleep(300)


stache.run(main)
