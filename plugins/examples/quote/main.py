import json
import time

import stache


def refresh():
    pairs = stache.settings().get("pairs", "USD-BRL,EUR-BRL,BTC-BRL").replace(" ", "")
    answer = stache.http_get(f"https://economia.awesomeapi.com.br/last/{pairs}")
    if not answer.get("ok") or answer.get("status") != 200:
        stache.card("quote", "Cotação", body=f"Sem dados ({answer.get('error') or answer.get('status')})")
        return
    data = json.loads(answer["body"])
    lines = []
    for item in data.values():
        value = float(item["bid"])
        change = float(item.get("pctChange") or 0)
        text = f"R$ {value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        lines.append((f'{item["code"]}', f"{text}  ({change:+.2f}%)", "success" if change > 0 else "danger" if change < 0 else "normal"))
    stache.card("quote", "Cotação", subtitle="Atualizado " + time.strftime("%H:%M"), lines=lines)


def main():
    while True:
        try:
            refresh()
        except Exception as error:  # noqa: BLE001
            stache.card("quote", "Cotação", body=f"Erro: {error}")
        time.sleep(60)


stache.run(main)
