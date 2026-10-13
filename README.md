# Stache

MVP de uma ilha dinâmica multiplataforma construída com Tauri 2, Vue 3 e
TypeScript.

## MVP atual

- Janela transparente, sem moldura, sempre no topo e fora da barra de tarefas.
- Posicionamento centralizado no topo do monitor atual.
- Reserva dinâmica de espaço no GNOME para manter as outras janelas abaixo do
  Stache.
- Transição entre cápsula compacta e painel expandido.
- Detecção de sessões MPRIS em reprodução (Spotify, VLC, navegadores e outros).
- Controles reais de reprodução, faixa anterior e próxima.
- Capa, aplicativo de origem, progresso e fundo baseado na cor predominante.
- Relógio compacto com hora e data quando não existe reprodução ativa.
- Retenção do player pausado durante o hover; a volta ao relógio ocorre 10
  segundos depois que o ponteiro sai da ilha.
- Aba **Início** na ilha expandida, depois de Mídia: calendário mensal e lista de
  tarefas salvas em SQLite local (`stache.db`, na pasta de dados do app).
- Suporte a movimento reduzido.

No Linux, o reprodutor usa MPRIS pelo barramento de sessão. A futura versão para
Windows usará Global System Media Transport Controls mantendo o mesmo contrato
do frontend.

## Estrutura

```text
src/
  components/       componentes Vue
  composables/      estado e comportamento da ilha
  types/            contratos compartilhados
src-tauri/
  src/lib.rs        janela nativa e comandos Tauri
```

## Desenvolvimento

```sh
npm install
npm run build
npm run tauri dev
```

O script `npm run tauri ...` remove automaticamente variáveis de runtime
herdadas do VS Code instalado por Snap. Sem essa limpeza, o WebKitGTK pode
carregar bibliotecas do Ubuntu Core e encerrar com um erro de `libpthread`.

O frontend também pode ser visualizado isoladamente com `npm run dev`.

Se o VS Code tiver sido instalado por Snap, o lançador detecta automaticamente
a política AppArmor do terminal integrado e inicia o Tauri em uma unidade
transitória do `systemd --user`. Isso permite ler players MPRIS instalados por
Snap sem alterar as políticas de segurança do sistema.

## Integração com o GNOME

O diretório `gnome-extension/` contém uma extensão auxiliar própria do Stache.
Ela reserva 30 px no topo, mesmo com a ilha expandida (o painel flutua sobre as
janelas), e mantém a janela do Stache colada ao topo e sempre à frente.

Depois da primeira instalação, encerre a sessão e entre novamente para o GNOME
Shell recarregar a lista de extensões. Em seguida, ative-a uma única vez:

```sh
gnome-extensions enable stache-reserved-space@alexlan
gnome-extensions info stache-reserved-space@alexlan
```

O pacote também traz uma cópia do ocultador da barra superior
(`hidetopbar@mathieu.bidon.ca`, GPL-3.0, em `gnome-extension/`) e, junto com a
extensão do Stache, a ativa para quem instalou, com intelli-hide e "ativar com o mouse"
desligados (a barra some e o Stache ocupa o topo). Sair e entrar na sessão é
necessário para o GNOME carregar as duas.

Não é necessário instalar nenhuma das extensões encontradas ao pesquisar por
“Wayland” no aplicativo Extensões.

## Tela de bloqueio no boot

O pacote `.deb` ativa o login automático do GDM para o usuário que instalou
(só se ainda não houver um configurado) e instala o serviço de usuário
`stache-lock.service`, que bloqueia a sessão logo após ligar o computador. Assim
o boot termina na tela de bloqueio do GNOME (papel de parede desfocado, avatar e
senha) em vez do login do GDM. Sair e entrar de novo não bloqueia. Ao remover o
pacote, o login automático criado por ele é desfeito.

O serviço `stache-lock-awake.service` também impede que o GNOME apague a tela
enquanto a sessão está bloqueada (Super+L, menu ou boot): bloquear só bloqueia.
A tela fica acesa até desbloquear.

Observação: com login automático o chaveiro (keyring) não é destravado pela
senha, então alguns apps podem pedir a senha dele depois.

Para desativar sem desinstalar:
`systemctl --user disable stache-lock.service` e remova `AutomaticLogin*` de
`/etc/gdm3/custom.conf`.

## Dependências nativas no Ubuntu

O Tauri requer Rust/Cargo, WebKitGTK 4.1, librsvg e as ferramentas de
compilação do sistema. Confirme o ambiente com:

```sh
npm run tauri info
```

## Mascotes e consumo de IA

- Os mascotes (Tick, Papo e Work) usam o Codex. Para gastar menos, Tick, Papo e as conversas rodam com raciocínio baixo; o contexto do app (tarefas, notificações) só é reenviado quando muda; o resumo da conversa só vai ao trocar de agente; e a thread é renovada a cada 12 turnos.
- Quando o limite do Codex se esgota (lido na conta ou recusado pelo próprio Codex), os mascotes **saem**: cada um avisa na ilha com uma desculpa em personagem conforme a hora (dormir, café, almoço, lanche, jantar, fim de semana ou férias, se a volta estiver longe), ninguém espia a ilha e conversas e tarefas respondem a desculpa sem gastar nada. Quando o limite libera, todos voltam e avisam na ilha, mesmo recolhida. O estado fica salvo e vale ao reabrir o Stache.
