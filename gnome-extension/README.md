# Stache Reserved Space

Extensão auxiliar para GNOME Shell 50. Ela cria uma faixa invisível com
`affectsStruts: true`, reservando espaço para a janela do Stache.

O serviço D-Bus `org.gnome.Shell.Extensions.Stache` expõe `SetHeight(u)` em
`/org/gnome/Shell/Extensions/Stache`. O backend Tauri envia `30` no estado
compacto e `180` no estado expandido.

A extensão não captura entrada, não acessa rede e remove ator, sinais e serviço
D-Bus integralmente em `disable()`.

## Instalação local

Empacote a pasta e instale o arquivo gerado:

```sh
gnome-extensions pack --force \
  --out-dir=../../build/gnome-extension \
  stache-reserved-space@alexlan
gnome-extensions install --force \
  ../../build/gnome-extension/stache-reserved-space@alexlan.shell-extension.zip
```

No Wayland, encerre a sessão e entre novamente após a primeira instalação.
Então execute:

```sh
gnome-extensions enable stache-reserved-space@alexlan
```
