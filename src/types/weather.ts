export interface WeatherLocation {
  id: string;
  name: string;
  detail: string;
  latitude: number;
  longitude: number;
  /** Localização detectada pelo IP, atualizada a cada abertura. */
  current?: boolean;
}

export interface WeatherData {
  fetchedAt: number;
  current: {
    temperature: number;
    apparent: number;
    humidity: number;
    wind: number;
    precipitation: number;
    code: number;
    isDay: boolean;
  };
  hourly: { time: string; temperature: number; code: number; rain: number; isDay: boolean }[];
  daily: { date: string; code: number; max: number; min: number; rain: number }[];
  sunrise: string;
  sunset: string;
}
