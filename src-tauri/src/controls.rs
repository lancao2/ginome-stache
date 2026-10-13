//! Central de controle: brilho, volume, rádios, energia e ações do sistema.
//!
//! No Linux cada controle usa a ferramenta padrão da área de trabalho
//! (WirePlumber, NetworkManager, BlueZ, logind e portais do GNOME).

use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    volume: u32,
    muted: bool,
    mic_muted: bool,
    brightness: Option<u32>,
    wifi: bool,
    bluetooth: bool,
    airplane: bool,
    night_light: bool,
    power_profile: String,
    battery: Option<u32>,
    charging: bool,
}

#[cfg(target_os = "linux")]
mod linux {
    use std::process::{Command, Stdio};

    pub fn run(program: &str, args: &[&str]) -> Option<String> {
        let output = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Inicia um programa sem esperar por ele.
    pub fn launch(program: &str, args: &[&str]) -> Result<(), String> {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("{program}: {error}"))
    }

    pub fn check(program: &str, args: &[&str]) -> Result<(), String> {
        run(program, args).map(|_| ()).ok_or_else(|| format!("{program} falhou"))
    }

    pub fn volume(target: &str) -> (u32, bool) {
        let text = run("wpctl", &["get-volume", target]).unwrap_or_default();
        let value = text
            .split_whitespace()
            .nth(1)
            .and_then(|number| number.parse::<f64>().ok())
            .unwrap_or(0.0);
        ((value * 100.0).round() as u32, text.contains("[MUTED]"))
    }

    fn backlight() -> Option<(String, u32, u32)> {
        let entry = std::fs::read_dir("/sys/class/backlight").ok()?.flatten().next()?;
        let read = |file: &str| std::fs::read_to_string(entry.path().join(file)).ok()?.trim().parse::<u32>().ok();
        Some((entry.file_name().to_string_lossy().into_owned(), read("brightness")?, read("max_brightness")?))
    }

    pub fn brightness() -> Option<u32> {
        let (_, value, max) = backlight()?;
        (max > 0).then(|| (value as f64 / max as f64 * 100.0).round() as u32)
    }

    pub fn set_brightness(percent: u32) -> Result<(), String> {
        use zbus::blocking::Connection;

        let (name, _, max) = backlight().ok_or_else(|| "sem controle de brilho".to_owned())?;
        // Mantém um mínimo para a tela nunca apagar por completo.
        let value = ((percent.clamp(3, 100) as f64 / 100.0) * max as f64).round() as u32;
        let connection = Connection::system().map_err(|error| error.to_string())?;
        connection
            .call_method(
                Some("org.freedesktop.login1"),
                "/org/freedesktop/login1/session/auto",
                Some("org.freedesktop.login1.Session"),
                "SetBrightness",
                &("backlight", name.as_str(), value),
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn wifi() -> bool {
        run("nmcli", &["radio", "wifi"]).is_some_and(|text| text.trim() == "habilitado" || text.trim() == "enabled")
    }

    pub fn bluetooth() -> bool {
        run("bluetoothctl", &["show"]).is_some_and(|text| text.lines().any(|line| line.trim() == "Powered: yes"))
    }

    pub fn night_light() -> bool {
        run("gsettings", &["get", "org.gnome.settings-daemon.plugins.color", "night-light-enabled"])
            .is_some_and(|text| text.trim() == "true")
    }

    pub fn power_profile() -> String {
        run("powerprofilesctl", &["get"]).map(|text| text.trim().to_owned()).unwrap_or_default()
    }

    pub fn battery() -> (Option<u32>, bool) {
        let text = run("upower", &["-i", "/org/freedesktop/UPower/devices/DisplayDevice"]).unwrap_or_default();
        let field = |key: &str| {
            text.lines()
                .find_map(|line| line.trim().strip_prefix(key))
                .map(|value| value.trim().to_owned())
        };
        let percent = field("percentage:").and_then(|value| value.trim_end_matches('%').trim().parse().ok());
        let charging = field("state:").is_some_and(|state| state == "charging" || state == "fully-charged");
        (percent, charging)
    }
}

/// Leitura leve (só sysfs) do estado de carregamento.
fn read_charging() -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") else { return false };
        return entries.flatten().any(|entry| {
            let path = entry.path();
            std::fs::read_to_string(path.join("type")).is_ok_and(|kind| kind.trim() == "Battery")
                && std::fs::read_to_string(path.join("status")).is_ok_and(|status| matches!(status.trim(), "Charging" | "Full"))
        });
    }
    #[cfg(not(target_os = "linux"))]
    false
}

#[tauri::command(async)]
pub fn get_charging() -> bool {
    read_charging()
}

/// Avisa a interface assim que o carregador é conectado ou removido. Dirigido a eventos do
/// udev (sem CPU em repouso); se o `udevadm` não existir, cai para uma leitura de sysfs a cada 3s.
pub fn start_charging_monitor(app: tauri::AppHandle) {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use tauri::Emitter;

    std::thread::spawn(move || {
        let mut last = read_charging();
        let mut publish = |app: &tauri::AppHandle| {
            let now = read_charging();
            if now != last {
                last = now;
                let _ = app.emit("charging-changed", now);
            }
        };
        loop {
            let child = Command::new("udevadm")
                .args(["monitor", "--udev", "--subsystem-match=power_supply"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn();
            match child {
                Ok(mut child) => {
                    if let Some(out) = child.stdout.take() {
                        for line in BufReader::new(out).lines().map_while(Result::ok) {
                            if line.contains("power_supply") { publish(&app); }
                        }
                    }
                    let _ = child.wait();
                    std::thread::sleep(std::time::Duration::from_secs(5));
                }
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    publish(&app);
                }
            }
        }
    });
}

#[tauri::command(async)]
pub fn get_controls() -> ControlState {
    #[cfg(target_os = "linux")]
    {
        let (volume, muted) = linux::volume("@DEFAULT_AUDIO_SINK@");
        let (_, mic_muted) = linux::volume("@DEFAULT_AUDIO_SOURCE@");
        let wifi = linux::wifi();
        let bluetooth = linux::bluetooth();
        let (battery, charging) = linux::battery();
        return ControlState {
            volume,
            muted,
            mic_muted,
            brightness: linux::brightness(),
            wifi,
            bluetooth,
            airplane: !wifi && !bluetooth,
            night_light: linux::night_light(),
            power_profile: linux::power_profile(),
            battery,
            charging,
        };
    }
    #[cfg(not(target_os = "linux"))]
    ControlState::default()
}

#[tauri::command(async)]
pub fn set_volume(percent: u32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let level = format!("{:.2}", percent.min(100) as f64 / 100.0);
        return linux::check("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", &level]);
    }
    #[cfg(not(target_os = "linux"))]
    Err(format!("volume não suportado: {percent}"))
}

#[tauri::command(async)]
pub fn set_muted(target: String, muted: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let device = if target == "mic" { "@DEFAULT_AUDIO_SOURCE@" } else { "@DEFAULT_AUDIO_SINK@" };
        return linux::check("wpctl", &["set-mute", device, if muted { "1" } else { "0" }]);
    }
    #[cfg(not(target_os = "linux"))]
    Err(format!("mudo não suportado: {target} {muted}"))
}

#[tauri::command(async)]
pub fn set_brightness(percent: u32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux::set_brightness(percent);
    #[cfg(not(target_os = "linux"))]
    Err(format!("brilho não suportado: {percent}"))
}

#[tauri::command(async)]
pub fn set_toggle(name: String, on: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let state = if on { "on" } else { "off" };
        return match name.as_str() {
            "wifi" => linux::check("nmcli", &["radio", "wifi", state]),
            "bluetooth" => linux::check("bluetoothctl", &["power", state]),
            // Modo avião liga/desliga todos os rádios de uma vez.
            "airplane" => {
                let radios = if on { "off" } else { "on" };
                let _ = linux::check("rfkill", &[if on { "block" } else { "unblock" }, "all"]);
                linux::check("nmcli", &["radio", "all", radios])
            }
            "nightlight" => linux::check(
                "gsettings",
                &["set", "org.gnome.settings-daemon.plugins.color", "night-light-enabled", if on { "true" } else { "false" }],
            ),
            _ => Err(format!("controle desconhecido: {name}")),
        };
    }
    #[cfg(not(target_os = "linux"))]
    Err(format!("controle não suportado: {name} {on}"))
}

#[tauri::command(async)]
pub fn set_power_profile(profile: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if !matches!(profile.as_str(), "power-saver" | "balanced" | "performance") {
            return Err(format!("perfil desconhecido: {profile}"));
        }
        return linux::check("powerprofilesctl", &["set", &profile]);
    }
    #[cfg(not(target_os = "linux"))]
    Err(format!("perfil não suportado: {profile}"))
}

#[tauri::command(async)]
pub fn system_action(action: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        return match action.as_str() {
            "screenshot" => linux::launch(
                "gdbus",
                &[
                    "call", "--session",
                    "--dest", "org.freedesktop.portal.Desktop",
                    "--object-path", "/org/freedesktop/portal/desktop",
                    "--method", "org.freedesktop.portal.Screenshot.Screenshot",
                    "", "{'interactive': <true>}",
                ],
            ),
            "settings" => linux::launch("gnome-control-center", &[]),
            "lock" => linux::launch("loginctl", &["lock-session"]),
            "suspend" => linux::launch("systemctl", &["suspend"]),
            "logout" => linux::launch("gnome-session-quit", &["--logout", "--no-prompt"]),
            "reboot" => linux::launch("systemctl", &["reboot"]),
            "poweroff" => linux::launch("systemctl", &["poweroff"]),
            _ => Err(format!("ação desconhecida: {action}")),
        };
    }
    #[cfg(not(target_os = "linux"))]
    Err(format!("ação não suportada: {action}"))
}
