import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

import type { ControlState, SystemAction, ToggleName } from "../types/controls";

const state = ref<ControlState>({
  volume: 0, muted: false, micMuted: false, brightness: null,
  wifi: true, bluetooth: true, airplane: false, nightLight: false,
  powerProfile: "", battery: null, charging: false,
});
const error = ref("");

async function call(command: string, args?: Record<string, unknown>) {
  try {
    error.value = "";
    await invoke(command, args);
    return true;
  } catch (cause) {
    error.value = String(cause);
    return false;
  }
}

const timers = new Map<string, number>();
// Sliders disparam muitos eventos; só o último valor de cada rajada é enviado.
function debounced(key: string, action: () => void) {
  const previous = timers.get(key);
  if (previous !== undefined) window.clearTimeout(previous);
  timers.set(key, window.setTimeout(() => { timers.delete(key); action(); }, 70));
}

export function useControls() {
  async function load() {
    try { state.value = await invoke<ControlState>("get_controls"); }
    catch { /* Browser preview. */ }
  }

  function setVolume(percent: number) {
    state.value.volume = percent;
    if (percent > 0) state.value.muted = false;
    debounced("volume", () => void call("set_volume", { percent }));
  }

  async function setMuted(target: "speaker" | "mic", muted: boolean) {
    if (target === "mic") state.value.micMuted = muted; else state.value.muted = muted;
    await call("set_muted", { target, muted });
  }

  function setBrightness(percent: number) {
    state.value.brightness = percent;
    debounced("brightness", () => void call("set_brightness", { percent }));
  }

  async function setToggle(name: ToggleName, on: boolean) {
    if (name === "wifi") { state.value.wifi = on; if (on) state.value.airplane = false; }
    if (name === "bluetooth") { state.value.bluetooth = on; if (on) state.value.airplane = false; }
    if (name === "airplane") { state.value.airplane = on; state.value.wifi = !on; state.value.bluetooth = !on; }
    if (name === "nightlight") state.value.nightLight = on;
    await call("set_toggle", { name, on });
    // Os rádios levam um instante para refletir o novo estado.
    window.setTimeout(() => void load(), 900);
  }

  async function setPowerProfile(profile: string) {
    state.value.powerProfile = profile;
    await call("set_power_profile", { profile });
  }

  const run = (action: SystemAction) => call("system_action", { action });

  return { state, error, load, setVolume, setMuted, setBrightness, setToggle, setPowerProfile, run };
}
