import { computed, ref, watch } from "vue";

import type { WeatherData, WeatherLocation } from "../types/weather";

const KEY = "stache.weather";
const REFRESH_AFTER = 15 * 60_000;

interface Saved { locations: WeatherLocation[]; selected: string; defaultId: string }

function read(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    return { locations: Array.isArray(saved.locations) ? saved.locations : [], selected: saved.selected ?? "current", defaultId: saved.defaultId ?? "" };
  } catch {
    return { locations: [], selected: "current", defaultId: "" };
  }
}

const saved = read();
// A localização atual vem do IP e sempre é a primeira da lista.
const current = ref<WeatherLocation | null>(saved.locations.find((item) => item.current) ?? null);
const others = ref<WeatherLocation[]>(saved.locations.filter((item) => !item.current));
// Cidade padrão: fica em primeiro e é a aberta ao iniciar o Stache.
const defaultId = ref(saved.defaultId);
const selectedId = ref(defaultId.value && saved.locations.some((item) => item.id === defaultId.value) ? defaultId.value : saved.selected);
const data = ref<Record<string, WeatherData>>({});
const loading = ref(false);
const error = ref("");

const locations = computed(() => {
  const all = current.value ? [current.value, ...others.value] : others.value;
  const preferred = all.find((item) => item.id === defaultId.value);
  return preferred ? [preferred, ...all.filter((item) => item !== preferred)] : all;
});
const selected = computed(() => locations.value.find((item) => item.id === selectedId.value) ?? locations.value[0] ?? null);
const weather = computed(() => (selected.value ? data.value[selected.value.id] ?? null : null));

watch([current, others, selectedId, defaultId], () => {
  try { localStorage.setItem(KEY, JSON.stringify({ locations: locations.value, selected: selectedId.value, defaultId: defaultId.value })); }
  catch { /* Sem armazenamento: vale só nesta sessão. */ }
}, { deep: true });

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export interface GeocodeResult { id: number; name: string; admin1?: string; country?: string; latitude: number; longitude: number }

export function useWeather() {
  async function detectLocation() {
    try {
      const place = await json<{ success?: boolean; city?: string; region?: string; country?: string; latitude?: number; longitude?: number }>("https://ipwho.is/");
      if (place.success === false || place.latitude === undefined || place.longitude === undefined) throw new Error("sem localização");
      current.value = {
        id: "current",
        name: place.city || "Localização atual",
        detail: [place.region, place.country].filter(Boolean).join(", "),
        latitude: place.latitude,
        longitude: place.longitude,
        current: true,
      };
      if (!locations.value.some((item) => item.id === selectedId.value)) selectedId.value = "current";
    } catch {
      if (!current.value) error.value = "Não consegui detectar sua localização. Adicione uma cidade.";
    }
  }

  async function load(force = false) {
    const target = selected.value;
    if (!target || loading.value) return;
    const cached = data.value[target.id];
    if (!force && cached && Date.now() - cached.fetchedAt < REFRESH_AFTER) return;
    loading.value = true;
    error.value = "";
    try {
      const query = new URLSearchParams({
        latitude: String(target.latitude),
        longitude: String(target.longitude),
        current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day",
        hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
        timezone: "auto",
        forecast_days: "7",
        wind_speed_unit: "kmh",
      });
      const body = await json<any>(`https://api.open-meteo.com/v1/forecast?${query}`);
      const now = body.current.time as string;
      const start = Math.max(0, (body.hourly.time as string[]).findIndex((time) => time >= now.slice(0, 13)));
      data.value[target.id] = {
        fetchedAt: Date.now(),
        current: {
          temperature: body.current.temperature_2m,
          apparent: body.current.apparent_temperature,
          humidity: body.current.relative_humidity_2m,
          wind: body.current.wind_speed_10m,
          precipitation: body.current.precipitation,
          code: body.current.weather_code,
          isDay: body.current.is_day === 1,
        },
        hourly: (body.hourly.time as string[]).slice(start, start + 24).map((time, index) => ({
          time,
          temperature: body.hourly.temperature_2m[start + index],
          code: body.hourly.weather_code[start + index],
          rain: body.hourly.precipitation_probability[start + index] ?? 0,
          isDay: body.hourly.is_day[start + index] === 1,
        })),
        daily: (body.daily.time as string[]).map((date, index) => ({
          date,
          code: body.daily.weather_code[index],
          max: body.daily.temperature_2m_max[index],
          min: body.daily.temperature_2m_min[index],
          rain: body.daily.precipitation_probability_max[index] ?? 0,
        })),
        sunrise: body.daily.sunrise[0],
        sunset: body.daily.sunset[0],
      };
    } catch (cause) {
      error.value = `Não consegui obter a previsão (${cause instanceof Error ? cause.message : cause}).`;
    } finally {
      loading.value = false;
    }
  }

  async function search(name: string): Promise<GeocodeResult[]> {
    const text = name.trim();
    if (text.length < 2) return [];
    const query = new URLSearchParams({ name: text, count: "6", language: "pt", format: "json" });
    const body = await json<{ results?: GeocodeResult[] }>(`https://geocoding-api.open-meteo.com/v1/search?${query}`);
    return body.results ?? [];
  }

  function add(result: GeocodeResult) {
    const id = `geo-${result.id}`;
    if (!locations.value.some((item) => item.id === id))
      others.value = [...others.value, { id, name: result.name, detail: [result.admin1, result.country].filter(Boolean).join(", "), latitude: result.latitude, longitude: result.longitude }];
    selectedId.value = id;
  }

  function remove(id: string) {
    others.value = others.value.filter((item) => item.id !== id);
    if (defaultId.value === id) defaultId.value = "";
    delete data.value[id];
    if (selectedId.value === id) selectedId.value = locations.value[0]?.id ?? "current";
  }

  function setDefault(id: string) {
    defaultId.value = defaultId.value === id ? "" : id;
  }

  return { locations, selected, selectedId, defaultId, setDefault, weather, loading, error, current, detectLocation, load, search, add, remove };
}
