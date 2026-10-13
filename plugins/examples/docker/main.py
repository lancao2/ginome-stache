import time

import stache

previous = None


def refresh():
    global previous
    result = stache.run_command(["docker", "ps", "-a", "--format", "{{.Names}}|{{.Status}}"])
    if not result.get("ok") or result.get("code") != 0:
        stache.card("docker", "Docker", body=(result.get("stderr") or result.get("error") or "docker indisponível").strip()[:200])
        return
    containers = {}
    for line in result["stdout"].splitlines():
        name, _, status = line.partition("|")
        containers[name] = status
    up = {name for name, status in containers.items() if status.startswith("Up")}
    if previous is not None:
        for name in sorted(previous - up):
            stache.alert("Docker", f"{name} parou", tone="warning")
    previous = up
    lines = [(name, status, "success" if name in up else "danger") for name, status in sorted(containers.items())][:10]
    stache.card("docker", "Docker", subtitle=f"{len(up)} de {len(containers)} em execução",
                lines=lines or [("Containers", "nenhum")])


def main():
    while True:
        try:
            refresh()
        except Exception as error:  # noqa: BLE001
            stache.card("docker", "Docker", body=f"Erro: {error}")
        time.sleep(15)


stache.run(main)
