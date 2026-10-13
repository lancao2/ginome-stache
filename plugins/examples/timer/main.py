import time

import stache

state = {"left": 0, "total": 0, "running": False}


def minutes():
    try:
        return max(1, min(480, int(float(stache.settings().get("minutes", "25")))))
    except ValueError:
        return 25


def render():
    left, total = state["left"], state["total"]
    shown = f"{left // 60:02d}:{left % 60:02d}"
    stache.card(
        "timer", "Timer", subtitle="Em andamento" if state["running"] else ("Pausado" if left < total else "Pronto"),
        lines=[("Restante", shown, "warning" if state["running"] and left <= 60 else "normal")],
        progress=(1 - left / total) if total else 0,
        actions=[("pause", "Pausar") if state["running"] else ("start", "Iniciar"), ("reset", "Reiniciar")],
    )


def on_action(card_id, action):
    if action == "start":
        state["running"] = True
    elif action == "pause":
        state["running"] = False
    elif action == "reset":
        state.update(running=False, left=minutes() * 60, total=minutes() * 60)
    render()


def main():
    state.update(left=minutes() * 60, total=minutes() * 60)
    stache.on_action(on_action)
    render()
    while True:
        time.sleep(1)
        if state["running"]:
            state["left"] -= 1
            if state["left"] <= 0:
                state.update(running=False, left=0)
                stache.alert("Timer", "Tempo esgotado!", tone="success")
            render()


stache.run(main)
