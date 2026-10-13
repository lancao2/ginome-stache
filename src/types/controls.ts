export interface ControlState {
  volume: number;
  muted: boolean;
  micMuted: boolean;
  brightness: number | null;
  wifi: boolean;
  bluetooth: boolean;
  airplane: boolean;
  nightLight: boolean;
  powerProfile: string;
  battery: number | null;
  charging: boolean;
}

export type SystemAction = "screenshot" | "settings" | "lock" | "suspend" | "logout" | "reboot" | "poweroff";
export type ToggleName = "wifi" | "bluetooth" | "airplane" | "nightlight";
