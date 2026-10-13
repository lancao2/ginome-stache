#!/bin/sh
set -e
if command -v systemctl >/dev/null 2>&1; then
    systemctl --global disable stache.service >/dev/null 2>&1 || true
    systemctl --global disable stache-lock.service >/dev/null 2>&1 || true
    systemctl --global disable stache-lock-awake.service >/dev/null 2>&1 || true
fi

# Só na remoção (não em atualização): desfaz o login automático que o instalador criou.
CONF=/etc/gdm3/custom.conf
MARK=/var/lib/stache/autologin-user
case "$1" in
    remove|purge)
        if [ -f "$MARK" ] && [ -f "$CONF" ]; then
            sed -i -e '/^AutomaticLoginEnable=True$/d' -e "/^AutomaticLogin=$(cat "$MARK")$/d" "$CONF"
            rm -f "$MARK"
        fi
        ;;
esac
exit 0
