"""SDK mínimo de plugins do Stache (Python 3, sem dependências).

O plugin roda numa caixa isolada, sem rede e sem acesso à sua pasta pessoal. Tudo o que
sai dela passa pelo Stache, que confere as permissões declaradas em plugin.json:

    import stache

    def main():
        stache.card("clima", "Clima", lines=[("Agora", "24°C")])

    stache.run(main)

Conversa com o Stache por linhas JSON em stdin/stdout (veja plugins/README.md).
Nunca use print() para depurar: escreva em sys.stderr.
"""
import json
import sys
import threading

_write_lock = threading.Lock()
_pending = {}
_next_id = 0
_action_handlers = []
_settings = {}
_ready = threading.Event()


def _send(message):
    with _write_lock:
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def settings():
    """Valores das opções declaradas em "settings" (texto), já com o que o usuário editou."""
    return dict(_settings)


def card(card_id, title, lines=None, body=None, progress=None, subtitle=None, icon=None,
         actions=None, url=None, tone=None):
    """Cria ou atualiza um cartão.

    lines:   lista de (rótulo, valor) ou (rótulo, valor, tom) — tom: normal|success|warning|danger
    progress: 0.0 a 1.0 (barra de progresso)
    actions: lista de (id, rótulo); o clique chama o on_action registrado
    url:     abre no navegador ao clicar no título
    """
    items = []
    for line in lines or []:
        label, value, *rest = line
        items.append({"label": str(label), "value": str(value), "tone": rest[0] if rest else "normal"})
    _send({
        "type": "card", "id": card_id, "title": title, "subtitle": subtitle, "icon": icon, "body": body,
        "progress": progress, "lines": items, "url": url, "tone": tone,
        "actions": [{"id": a, "label": l} for a, l in (actions or [])],
    })


def remove_card(card_id):
    _send({"type": "remove_card", "id": card_id})


def alert(label, text, tone="normal", url=None):
    """Aviso na cápsula do Stache (precisa de "alerts": true nas permissões)."""
    _send({"type": "alert", "label": label, "text": text, "tone": tone, "url": url})


def request(op, timeout=30, **fields):
    """Pedido ao Stache (http.get, exec…). Bloqueia até a resposta."""
    global _next_id
    event = threading.Event()
    with _write_lock:
        _next_id += 1
        req = _next_id
    _pending[req] = [event, None]
    _send({"type": "request", "req": req, "op": op, **fields})
    event.wait(timeout)
    return (_pending.pop(req, [None, None])[1]) or {"ok": False, "error": "sem resposta do Stache"}


def http_get(url, headers=None, head=False):
    """GET (ou HEAD) por host permitido em "network". Devolve {ok, status, body, elapsed_ms, error}."""
    return request("http", url=url, headers=headers or {}, method="HEAD" if head else "GET")


def run_command(argv):
    """Executa um comando permitido em "exec". Devolve {ok, code, stdout, stderr, error}."""
    return request("exec", argv=list(argv))


def on_action(handler):
    """handler(card_id, action_id) é chamado quando o usuário clica num botão de cartão."""
    _action_handlers.append(handler)


def _reader():
    for raw in sys.stdin:
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        kind = message.get("type")
        if kind == "init":
            _settings.update(message.get("settings") or {})
            _ready.set()
        elif kind == "response":
            slot = _pending.get(message.get("req"))
            if slot:
                slot[1] = message
                slot[0].set()
        elif kind == "action":
            for handler in list(_action_handlers):
                threading.Thread(target=handler, args=(message.get("card"), message.get("action")), daemon=True).start()
    # stdin fechou: o Stache encerrou o plugin.
    import os
    os._exit(0)


def run(main):
    """Inicia a conversa com o Stache e roda main() depois de receber as opções."""
    threading.Thread(target=_reader, daemon=True).start()
    _ready.wait(10)
    main()
    threading.Event().wait()
