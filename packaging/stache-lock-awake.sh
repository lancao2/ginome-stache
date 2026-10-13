#!/bin/sh
# O GNOME apaga a tela ~10 s depois de qualquer bloqueio (Super+L, menu, boot). Enquanto a
# sessão estiver bloqueada, este script simula atividade para a tela ficar só bloqueada,
# acesa, mostrando a tela de bloqueio. Ao desbloquear, tudo volta ao normal.
call() {
    gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver \
        --method "org.gnome.ScreenSaver.$1" 2>/dev/null
}
while :; do
    if call GetActive | grep -q true; then
        call SimulateUserActivity >/dev/null
    fi
    sleep 4
done
