# Plugins do Stache

Um plugin é uma pasta em `~/.local/share/com.alexlan.stache/plugins/<id>/` (botão
**Configurações → Ajustes do Stache → Plugins → Abrir pasta**) com um `plugin.json` e um
programa em qualquer linguagem. Ele cria **cartões** (aba Widgets) e **avisos** (cápsula).

## Isolamento

O programa roda dentro do [bubblewrap](https://github.com/containers/bubblewrap): sem rede,
sem a sua pasta pessoal, sem ver os outros processos, com `/usr` e o próprio plugin somente
leitura. `/tmp` e `/data` são temporários (`/data` é persistente com a permissão `storage`).
Tudo o que sai da caixa passa pelo Stache, que confere o manifesto. Sem `bwrap` instalado,
nenhum plugin é executado. Ligar um plugin é aprovar as permissões mostradas; se o manifesto
pedir mais depois, ele desliga até ser aprovado de novo.

## plugin.json

```json
{
  "id": "meu-plugin",              // igual ao nome da pasta: a-z 0-9 - _
  "name": "Meu plugin",
  "version": "1.0.0",
  "description": "O que faz.",
  "main": ["python3", "main.py"],  // comando de início, na pasta do plugin
  "permissions": {
    "network": ["api.exemplo.com", "*.cdn.com"],  // "*" = qualquer site público
    "exec": [["docker", "ps"]],                   // comandos (início do argv) permitidos
    "alerts": true,                               // avisos na cápsula
    "storage": true                               // pasta persistente /data
  },
  "settings": [
    { "key": "repo", "label": "Repositório", "default": "dono/nome", "hint": "…" }
  ]
}
```

Rede local (`localhost`, `192.168.x.x`…) só funciona se o host estiver listado por extenso.
Redirecionamentos não são seguidos: o plugin recebe o `location` e decide.

## Protocolo

Linhas JSON em stdin (Stache → plugin) e stdout (plugin → Stache). Use stderr para depurar.

Plugin → Stache:

| mensagem | campos |
|---|---|
| `card` | `id`, `title`, `subtitle?`, `body?`, `progress?` (0–1), `lines?` `[{label,value,tone}]`, `actions?` `[{id,label}]`, `url?`, `tone?` (`normal`/`success`/`warning`/`danger`) |
| `remove_card` | `id` |
| `alert` | `text`, `label?`, `tone?`, `url?` (precisa de `alerts`) |
| `request` | `req` (número), `op`: `http` (`url`, `method` GET/HEAD, `headers?`) ou `exec` (`argv`) |

Stache → plugin: `init` `{settings}`, `response` `{req, ok, …}` (http: `status`, `body`, `elapsed_ms`,
`location`; exec: `code`, `stdout`, `stderr`; erro: `error`), `action` `{card, action}`.

Limites: 8 cartões por plugin, 12 linhas e 4 botões por cartão, 20 atualizações de cartão/s,
1 aviso a cada 3 s (20/h), respostas HTTP de até 2 MB, comandos até 10 s e 256 KB de saída.
Textos são exibidos como texto puro: não há HTML nem scripts nos cartões.

## SDK Python

`plugins/sdk/stache.py` (já disponível como `import stache` dentro da caixa):

```python
import stache

def main():
    r = stache.http_get("https://api.exemplo.com/dados")
    stache.card("dados", "Dados", lines=[("Valor", r["body"][:20])], actions=[("again", "Atualizar")])
    stache.on_action(lambda card, action: main())

stache.run(main)
```

Exemplos prontos em `plugins/examples/`: **timer**, **quote** (cotação), **github**, **docker**
e **status** (servidores). Instale-os pelo botão “Instalar exemplos”.
