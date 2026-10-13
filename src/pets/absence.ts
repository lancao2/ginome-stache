// Ausência dos mascotes quando os tokens do Codex acabam: motivo pela hora do dia, desculpa por personagem e volta.
// Funções puras, sem Vue nem Tauri.
import { PET_ENGINE, PET_IDS, type PetId } from "./data.ts";

export type AwayReason = "noite" | "cafe" | "almoco" | "lanche" | "jantar" | "fimdesemana" | "ferias" | "geral";

export interface Away {
  since: number;
  /** Instante previsto da volta; `null` quando o limite estourou mas não se sabe quando libera. */
  until: number | null;
  reason: AwayReason;
  /** "usage": o limite lido na conta; "error": o Codex recusou um pedido por limite. */
  source: "usage" | "error";
  /** Índice da desculpa de cada mascote, sorteado uma vez para o texto não mudar a cada leitura. */
  picks: Record<PetId, number>;
}

interface UsageLike {
  id: string;
  status: string;
  windows: { usedPercent: number; resetsAt: string | null }[];
}

/** A partir daqui a janela conta como esgotada. */
export const EXHAUSTED_AT = 99;
/** Sem horário de liberação, espera isso antes de voltar a tentar. */
export const UNKNOWN_HOLD_MS = 30 * 60_000;
const MEAL_MAX_HOURS = 3;
const NIGHT_MAX_HOURS = 12;
const LONG_HOURS = 18;

const MEALS: { reason: AwayReason; from: number; to: number }[] = [
  { reason: "cafe", from: 6, to: 9.5 },
  { reason: "almoco", from: 11.5, to: 14.5 },
  { reason: "lanche", from: 15.5, to: 17.5 },
  { reason: "jantar", from: 18.5, to: 21.5 },
];

/** Janela de uso esgotada do motor dos mascotes: devolve quando libera, ou `null` se nada estourou. */
export function usageBlock(usage: UsageLike[], now: number): { until: number | null } | null {
  const engine = usage.find((item) => item.id === PET_ENGINE && item.status === "ok");
  if (!engine) return null;
  const exhausted = engine.windows.filter((window) => window.usedPercent >= EXHAUSTED_AT);
  if (!exhausted.length) return null;
  const resets = exhausted.map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : NaN)).filter((time) => Number.isFinite(time));
  // Uma janela já vencida no cache não segura ninguém: o próximo ciclo lê o valor novo.
  if (resets.length && resets.every((time) => time <= now)) return null;
  return { until: resets.length ? Math.max(...resets) : null };
}

/** O erro do Codex foi por limite de uso (e não por limite de ritmo, que passa sozinho)? */
export function isUsageLimit(info: unknown, message = ""): boolean {
  if (info === "usageLimitExceeded") return true;
  return /usage limit|limite de uso|hit your .*limit/i.test(message);
}

export function pickReason(now: Date, until: number | null): AwayReason {
  const hours = until === null ? null : Math.max(0, (until - now.getTime()) / 3_600_000);
  const hour = now.getHours() + now.getMinutes() / 60;
  if (hours !== null && hours > LONG_HOURS) return "ferias";
  if ((hour >= 22 || hour < 6) && (hours === null || hours <= NIGHT_MAX_HOURS)) return "noite";
  if (hours === null || hours <= MEAL_MAX_HOURS) {
    const meal = MEALS.find((item) => hour >= item.from && hour < item.to);
    if (meal) return meal.reason;
  }
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  return weekend ? "fimdesemana" : "geral";
}

const WEEKDAY = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const clock = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** "às 14:10", "amanhã às 08:00", "sexta às 08:00" ou, sem previsão, "quando der". */
export function returnLabel(until: number | null, now: number): string {
  if (until === null) return "quando der";
  const target = new Date(Math.max(until, now));
  const today = new Date(now);
  const days = Math.round((new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime()
    - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return `às ${clock(target)}`;
  if (days === 1) return `amanhã às ${clock(target)}`;
  return `${WEEKDAY[target.getDay()]} às ${clock(target)}`;
}

/** {volta} vira o horário da volta. */
export const EXCUSES: Record<PetId, Record<AwayReason, string[]>> = {
  tick: {
    noite: ["Meu expediente acabou. Fui dormir, pontualmente. Volto {volta}.", "Tic-tac… zzz. Até o relógio precisa descansar. Volto {volta}.", "Desliguei em ponto. Sono também é compromisso. Volto {volta}."],
    cafe: ["Pausa do café, cronometrada: volto {volta}.", "Fui tomar café. Ninguém planeja o dia de estômago vazio. Volto {volta}."],
    almoco: ["Saí para almoçar! Marquei na agenda: volto {volta}.", "Almoço em andamento. Sim, eu cronometro a mastigação. Volto {volta}.", "Fui almoçar e deixei um lembrete para eu mesmo voltar {volta}."],
    lanche: ["Hora do lanchinho, previsto na agenda desde ontem. Volto {volta}.", "Fui lanchar. Quinze minutos, nem um tique a mais. Volto {volta}."],
    jantar: ["Jantar é sagrado e está no calendário. Volto {volta}.", "Fui jantar. Pontualidade também se aplica ao garfo. Volto {volta}."],
    fimdesemana: ["É fim de semana e até o meu relógio folga. Volto {volta}.", "Agenda vazia, ponteiros descansando. Volto {volta}."],
    ferias: ["Tirei férias! Remarquei todos os compromissos. Volto {volta}.", "Fui trocar as pilhas do tempo. Volto {volta}."],
    geral: ["Entrei em manutenção programada. Volto {volta}.", "Meus ponteiros pararam para um café sem açúcar. Volto {volta}."],
  },
  papo: {
    noite: ["Piu… fui para o ninho dormir. Sonho com vocês! Volto {volta}.", "Já recolhi as penas e fui dormir. Piu! Volto {volta}.", "Estou no ninho, de olhinho fechado e bico quieto. Volto {volta}."],
    cafe: ["Fui tomar café com os pombos da praça! Piu! Volto {volta}.", "Saí para um cafezinho e uma fofoca matinal. Volto {volta}!"],
    almoco: ["Saí para almoçar com as andorinhas! Já volto, {volta}!", "Fui almoçar e colocar a conversa em dia no refeitório. Volto {volta}!", "Piu! Estou almoçando alpiste. Volto {volta}!"],
    lanche: ["Lanchinho com os sabiás! Volto {volta}. Piu!", "Fui lanchar migalhas e coletar novidades. Volto {volta}!"],
    jantar: ["Fui jantar num fio de poste (o wi-fi de lá é ótimo). Volto {volta}!", "Piu! Jantar com a família do galho. Volto {volta}!"],
    fimdesemana: ["Fim de semana é dia de revoada! Volto {volta}. Piu!", "Fui passear com a turma do parque. Volto {volta}!"],
    ferias: ["Migrei para o sul, piu! Mando cartão-postal. Volto {volta}.", "Estou de férias num galho com vista para o mar. Volto {volta}!"],
    geral: ["Saí para bater papo com os vizinhos do galho. Volto {volta}!", "Fui espalhar as novidades pela vizinhança. Volto {volta}. Piu!"],
  },
  work: {
    noite: ["Modo de baixo consumo. Não me acorda. Volto {volta}.", "Fui dormir. Parafuso também precisa de folga. Volto {volta}.", "Desliguei tudo e fui descansar. Volto {volta}. Hmpf."],
    cafe: ["Fui calibrar a cafeteira. Volto {volta}. Não toca em nada.", "Café. Sem ele eu não compilo. Volto {volta}."],
    almoco: ["Saí para almoçar. Sim, parafuso também come. Volto {volta}.", "Almoço. Não é pausa, é manutenção do operador. Volto {volta}.", "Fui almoçar. Se algo quebrar, anota que eu vejo {volta}."],
    lanche: ["Lanche. Lubrificação preventiva. Volto {volta}.", "Fui lanchar. Hmpf. Volto {volta}."],
    jantar: ["Jantar. Reiniciar o estômago leva tempo. Volto {volta}.", "Fui jantar. Deixei tudo estável. Volto {volta}."],
    fimdesemana: ["Fim de semana: folga contratual. Volto {volta}. Hmpf.", "Hoje não tem expediente. Volto {volta}."],
    ferias: ["Fui para a oficina de manutenção geral. Volto {volta}. Não toca em nada.", "Peça nova a caminho. Volto {volta}."],
    geral: ["Fiquei sem energia para continuar. Fui carregar. Volto {volta}.", "Tô fora de serviço por falta de combustível. Volto {volta}. Hmpf."],
  },
};

export const RETURN_LINES: Record<PetId, string[]> = {
  tick: ["Voltei! Dentro do horário, claro.", "Tic-tac, de volta ao cronograma!", "Cheguei. Alguém me deve alguns minutos de agenda."],
  papo: ["Piu piu! Voltei! Senti tanta saudade!", "Cheguei! Tenho muita novidade para contar!", "Voltei, voltei, voltei! Piu!"],
  work: ["Voltei. Alguma coisa quebrou enquanto eu estava fora?", "De volta. Hmpf. Pelo menos o terminal está aberto.", "Voltei. Não precisa fazer festa."],
};

export function freshPicks(rand: () => number = Math.random): Record<PetId, number> {
  return Object.fromEntries(PET_IDS.map((id) => [id, Math.floor(rand() * 1000)])) as Record<PetId, number>;
}

export function newAway(now: number, until: number | null, source: Away["source"], rand: () => number = Math.random): Away {
  return { since: now, until, reason: pickReason(new Date(now), until), source, picks: freshPicks(rand) };
}

export function excuseLine(pet: PetId, away: Away, now: number): string {
  const lines = EXCUSES[pet][away.reason];
  return lines[away.picks[pet] % lines.length].replace("{volta}", returnLabel(away.until, now));
}

export function returnLine(pet: PetId, rand: () => number = Math.random): string {
  const lines = RETURN_LINES[pet];
  return lines[Math.floor(rand() * lines.length)];
}

/** Falas de volta que mexem nas necessidades: comer e dormir fazem bem. */
export function returnBoost(reason: AwayReason): Partial<Record<"fome" | "carinho" | "diversao", number>> {
  if (reason === "noite") return { fome: 10, carinho: 10, diversao: 10 };
  if (reason === "ferias" || reason === "fimdesemana") return { diversao: 20, carinho: 10 };
  if (reason === "geral") return {};
  return { fome: 20 };
}

export const AWAY_REASON_LIST: AwayReason[] = ["noite", "cafe", "almoco", "lanche", "jantar", "fimdesemana", "ferias", "geral"];
