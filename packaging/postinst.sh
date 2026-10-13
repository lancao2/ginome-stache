#!/bin/sh
# Liga o Stache para todos os usuários: ele sobe junto com a sessão do GNOME.
# (Cada pessoa pode desligar em Configurações → Ajustes do Stache → Iniciar com o computador.)
set -e
if command -v systemctl >/dev/null 2>&1; then
    systemctl --global enable stache.service >/dev/null 2>&1 || true
    # Bloqueia a sessão no boot: a tela de bloqueio do GNOME substitui o login do GDM.
    systemctl --global enable stache-lock.service >/dev/null 2>&1 || true
    systemctl --global enable stache-lock-awake.service >/dev/null 2>&1 || true
fi

# Login automático no GDM para quem instalou, para o boot cair na tela de bloqueio.
# Não mexe se o administrador já configurou login automático.
CONF=/etc/gdm3/custom.conf
MARK=/var/lib/stache/autologin-user
TARGET="${SUDO_USER:-}"
[ -n "$TARGET" ] && [ "$TARGET" != root ] || TARGET=$(getent passwd 1000 | cut -d: -f1)
if [ -f "$CONF" ] && [ -n "$TARGET" ] && ! grep -Eq '^[[:space:]]*AutomaticLogin(Enable)?[[:space:]]*=' "$CONF"; then
    if grep -q '^\[daemon\]' "$CONF"; then
        sed -i "/^\[daemon\]/a AutomaticLoginEnable=True\nAutomaticLogin=$TARGET" "$CONF"
    else
        printf '\n[daemon]\nAutomaticLoginEnable=True\nAutomaticLogin=%s\n' "$TARGET" >> "$CONF"
    fi
    mkdir -p /var/lib/stache
    echo "$TARGET" > "$MARK"
fi

# Ativa as extensões do GNOME (reserva de 30 px do Stache e ocultador da barra superior) para
# quem instalou. O GNOME só as carrega depois de sair e entrar na sessão.
ENABLE_UID=$(id -u "$TARGET" 2>/dev/null || true)
if [ -n "$ENABLE_UID" ] && [ -S "/run/user/$ENABLE_UID/bus" ] && command -v runuser >/dev/null 2>&1; then
    run_user() {
        runuser -u "$TARGET" -- env XDG_RUNTIME_DIR="/run/user/$ENABLE_UID" \
            DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$ENABLE_UID/bus" "$@"
    }
    current=$(run_user gsettings get org.gnome.shell enabled-extensions 2>/dev/null || true)
    if [ -n "$current" ]; then
        for uuid in stache-reserved-space@alexlan hidetopbar@mathieu.bidon.ca; do
            case "$current" in *"$uuid"*) continue ;; esac
            list=$(printf '%s' "$current" | sed -e 's/^@as //' -e 's/^\[//' -e 's/\]$//')
            if [ -z "$list" ]; then current="['$uuid']"; else current="[$list, '$uuid']"; fi
            run_user gsettings set org.gnome.shell enabled-extensions "$current" >/dev/null 2>&1 || true
            if [ "$uuid" = hidetopbar@mathieu.bidon.ca ]; then
                for key in enable-active-window enable-intellihide mouse-sensitive; do
                    run_user gsettings --schemadir /usr/share/gnome-shell/extensions/$uuid/schemas \
                        set org.gnome.shell.extensions.hidetopbar "$key" false >/dev/null 2>&1 || true
                done
            fi
        done
    fi
fi
exit 0
