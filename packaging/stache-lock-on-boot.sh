#!/bin/sh
# Com o login automático do GDM, a sessão abre direto no desktop. Este script bloqueia a
# sessão logo na inicialização do computador, para o boot terminar na tela de bloqueio do
# GNOME (papel de parede desfocado, avatar e senha) em vez do login do GDM.
# Só age nos primeiros minutos após ligar a máquina: sair e entrar de novo não bloqueia.
up=$(cut -d. -f1 /proc/uptime)
[ "$up" -lt 180 ] || exit 0

# Espera o GNOME Shell registrar o serviço de bloqueio (até ~30 s).
i=0
until gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.NameHasOwner org.gnome.ScreenSaver 2>/dev/null | grep -q true; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || exit 0
    sleep 0.5
done

screensaver() {
    gdbus call --session --dest org.gnome.ScreenSaver --object-path /org/gnome/ScreenSaver \
        --method "org.gnome.ScreenSaver.$1" >/dev/null 2>&1
}

screensaver Lock

