import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import ts from "typescript";

// O Node do sistema não roda TypeScript: transpila src/pets/*.ts para uma pasta temporária e importa de lá.
const SOURCE = resolve(import.meta.dirname, "../src/pets");
const OUT = mkdtempSync(join(tmpdir(), "stache-pets-"));
mkdirSync(OUT, { recursive: true });
for (const file of readdirSync(SOURCE).filter((name) => name.endsWith(".ts"))) {
  const { outputText } = ts.transpileModule(readFileSync(join(SOURCE, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  writeFileSync(join(OUT, file.replace(/\.ts$/, ".mjs")), outputText.replace(/(from\s+")(\.\/[^"]+)\.ts(")/g, "$1$2.mjs$3"));
}
const load = (name) => import(pathToFileURL(join(OUT, `${name}.mjs`)).href);
const { NEEDS, PET_ENGINE, PET_IDS, PROFILES, STATE_LABEL, pickLine } = await load("data");
const {
  ALERT_COOLDOWN_MS, COOLDOWN_MIN, LIMITS, advance, advanceOffline, alertDue, applyCare, applyTaskDone, average, canWork,
  deriveState, freshPet, isSad, isSleepTime, mediaFactor, needsCare,
} = await load("engine");
const { personaInstructions, stateLine, taskInstructions } = await load("persona");
const {
  ABSENCE_MIN_HOURS, absenceOf, anniversaryDue, dailyEventDue, dayKey, daysBetween, daysTogether, freshMemory, memorySummary, touch,
} = await load("memory");
const { EVENT_TITLE, LINES, absenceLine, eventLine } = await load("lines");
const { mentionedPet, routePet } = await load("router");
const {
  AWAY_REASON_LIST, EXCUSES, RETURN_LINES, excuseLine, isUsageLimit, newAway, pickReason, returnBoost, returnLabel, returnLine, usageBlock,
} = await load("absence");
const { CONTEXT, MAX_THREAD_TURNS, clip, contextToSend, effortFor, needsShared } = await load("budget");

const NOW = Date.UTC(2026, 9, 12, 15, 0, 0);
const tick = PROFILES.tick;
const work = PROFILES.work;
const withNeeds = (patch) => ({ ...freshPet(NOW), needs: { ...freshPet(NOW).needs, ...patch } });
const calm = { sleeping: false, mediaPlaying: false };

test("roteamento: qualquer pedido que informe uma data pertence ao Tick", () => {
  for (const prompt of [
    "Qual é o próximo feriado?",
    "Que dia é hoje?",
    "Quando é 02/11/2026?",
    "Edite o arquivo na próxima segunda-feira",
    "Qual foi a data de lançamento desta API?",
    "Tenho compromissos amanhã?",
  ]) assert.equal(routePet(prompt), "tick", prompt);
  assert.equal(routePet("Responda esta mensagem do WhatsApp"), "papo");
  assert.equal(routePet("Corrija o bug e rode os testes"), "work");
});

test("roteamento: citar um agente explicitamente sempre tem prioridade", () => {
  assert.equal(mentionedPet("Pede para o Papo verificar minhas mensagens"), "papo");
  assert.equal(routePet("Papo, verifique as mensagens recebidas e o que é urgente"), "papo");
  assert.equal(routePet("Tick, qual a data de lançamento desta API?"), "tick");
  assert.equal(routePet("@work organize os arquivos de hoje"), "work");
});

test("dados: os 3 mascotes usam o Codex e têm tudo preenchido", () => {
  assert.deepEqual([...PET_IDS], ["tick", "papo", "work"]);
  assert.equal(PET_ENGINE, "codex");
  for (const id of PET_IDS) {
    const profile = PROFILES[id];
    assert.equal(profile.engine, "codex");
    assert.ok(NEEDS.includes(profile.irritante));
    for (const need of NEEDS) assert.ok(profile.taxas[need] > 0, `${id}.${need}`);
    for (const key of ["parado", "cheio", "cooldown", "recusa", "fome", "raiva", "triste"]) assert.ok(profile.falas[key]?.length, `${id}.${key}`);
    assert.ok(pickLine(id, "recusa").length > 0);
    assert.ok(profile.falas.parado.every((line) => typeof line === "string" && line.trim()));
  }
  for (const state of Object.keys(STATE_LABEL)) assert.ok(STATE_LABEL[state]);
});

test("desgaste: cai com o tempo e a necessidade irritante cai mais rápido sob pressão", () => {
  const base = advance(freshPet(NOW), tick, 1, 0, 0);
  assert.ok(base.needs.fome < 80 && base.needs.fome > 70);
  const pressured = advance(freshPet(NOW), tick, 1, 5, 0);
  assert.ok(pressured.needs.proposito < base.needs.proposito, "pressão acelera o Propósito do Tick");
  assert.equal(pressured.needs.fome, base.needs.fome, "pressão não afeta as outras necessidades");
  assert.ok(advance(withNeeds({ fome: 1 }), tick, 10, 0, 0).needs.fome >= 0, "nunca fica negativo");
});

test("música: enche a Diversão só até o teto e nunca depois dele", () => {
  const low = advance(withNeeds({ diversao: 20 }), tick, 0.5, 0, 1);
  assert.ok(low.needs.diversao > 20, "sobe com música");
  const capped = advance(withNeeds({ diversao: 20 }), tick, 5, 0, 1.5);
  assert.equal(capped.needs.diversao, 80, "teto da música é 80");
  const above = advance(withNeeds({ diversao: 95 }), tick, 0.5, 0, 1.5);
  assert.ok(above.needs.diversao <= 95, "acima do teto a música não ajuda");
});

test("música: gosto do mascote e faixa repetida mudam o ganho", () => {
  assert.equal(mediaFactor(tick, "Chill lofi beats", 0), 1.5);
  assert.equal(mediaFactor(tick, "Heavy Metal", 0), 1);
  assert.equal(mediaFactor(work, "Daft Punk", 0), LIMITS.likedFactor);
  assert.equal(mediaFactor(work, "Daft Punk", 6), 1.5 * 0.25);
  assert.equal(mediaFactor(tick, "qualquer coisa", LIMITS.repeatMinutes), LIMITS.repeatFactor);
});

test("app fechado: só desgaste, com teto de horas e piso", () => {
  const away = advanceOffline(freshPet(NOW), tick, 100);
  const capped = advanceOffline(freshPet(NOW), tick, LIMITS.offlineMaxHours);
  assert.deepEqual(away.needs, capped.needs, "mais de 8 h conta como 8 h");
  for (const need of NEEDS) assert.ok(away.needs[need] >= LIMITS.offlineFloor, `${need} respeita o piso`);
  const below = advanceOffline(withNeeds({ fome: 5 }), tick, 8);
  assert.equal(below.needs.fome, 5, "quem já estava abaixo do piso não ganha nada");
});

test("estado: ordem de prioridade", () => {
  const happy = { fome: 90, diversao: 90, higiene: 90, carinho: 90, proposito: 90 };
  assert.equal(deriveState(tick, happy, calm), "feliz");
  assert.equal(deriveState(tick, { ...happy, fome: 60 }, calm), "feliz");
  assert.equal(deriveState(tick, { fome: 60, diversao: 60, higiene: 60, carinho: 60, proposito: 60 }, calm), "parado");
  assert.equal(deriveState(tick, happy, { sleeping: false, mediaPlaying: true }), "musica");
  assert.equal(deriveState(tick, { ...happy, diversao: 10 }, { sleeping: false, mediaPlaying: true }), "entediado", "tédio vence a música");
  assert.equal(deriveState(tick, { ...happy, fome: 10 }, calm), "fome");
  assert.equal(deriveState(tick, { ...happy, proposito: 10 }, calm), "raiva", "irritante do Tick é o Propósito");
  assert.equal(deriveState(work, { ...happy, higiene: 10 }, calm), "raiva", "irritante do Work é a Higiene");
  assert.equal(deriveState(tick, { ...happy, proposito: 10, fome: 10 }, calm), "raiva", "raiva vence a fome");
  assert.equal(deriveState(tick, { fome: 10, diversao: 10, higiene: 10, carinho: 10, proposito: 10 }, calm), "triste", "tristeza vence a raiva");
  assert.equal(deriveState(tick, happy, { sleeping: true, mediaPlaying: false }), "dormindo", "sono vence tudo");
});

test("tristeza: média abaixo do limite bloqueia tarefas com IA", () => {
  const sad = withNeeds({ fome: 10, diversao: 10, higiene: 10, carinho: 10, proposito: 10 });
  assert.ok(isSad(sad.needs) && average(sad.needs) < LIMITS.sad);
  assert.equal(canWork(sad), false);
  assert.equal(canWork(freshPet(NOW)), true);
  assert.equal(canWork(withNeeds({ fome: 5 })), true, "uma necessidade crítica sozinha não bloqueia");
});

test("cuidado: efeitos, tempo de espera e recusa quando já está cheio", () => {
  const hungry = withNeeds({ fome: 30 });
  const fed = applyCare(hungry, "comer", NOW);
  assert.ok(fed.ok);
  assert.equal(fed.data.needs.fome, 65);
  const again = applyCare(fed.data, "comer", NOW + 60_000);
  assert.equal(again.ok, false);
  const stillFull = applyCare(withNeeds({ fome: 95 }), "comer", NOW);
  assert.deepEqual([stillFull.ok, stillFull.reason], [false, "cheio"]);
  const wait = applyCare({ ...hungry, needs: { ...hungry.needs, fome: 10 }, lastCare: { comer: NOW } }, "comer", NOW + 60_000);
  assert.deepEqual([wait.ok, wait.reason], [false, "cooldown"]);
  assert.equal(wait.waitMs, COOLDOWN_MIN.comer * 60_000 - 60_000);
  const later = applyCare({ ...hungry, lastCare: { comer: NOW } }, "comer", NOW + COOLDOWN_MIN.comer * 60_000);
  assert.ok(later.ok, "depois do tempo de espera volta a funcionar");
  const played = applyCare(withNeeds({ diversao: 10 }), "brincar", NOW);
  assert.equal(played.data.needs.diversao, 40);
  assert.equal(played.data.needs.higiene, 81, "brincar suja um pouco");
  assert.equal(applyCare(withNeeds({ higiene: 10 }), "banho", NOW).data.needs.higiene, 55);
  assert.equal(applyCare(withNeeds({ carinho: 10 }), "conversar", NOW).data.needs.carinho, 35);
  assert.equal(applyCare(withNeeds({ fome: 99.9 }), "comer", NOW).ok, false);
  assert.ok(applyCare(hungry, "comer", NOW).data.lastInteraction === NOW);
});

test("tarefas: sucesso enche o Propósito, falha cansa e entristece", () => {
  const start = withNeeds({ proposito: 50, higiene: 50, carinho: 50, diversao: 50 });
  const ok = applyTaskDone(start, true, NOW);
  assert.equal(ok.needs.proposito, 70);
  assert.equal(ok.needs.higiene, 46);
  const fail = applyTaskDone(start, false, NOW);
  assert.equal(fail.needs.proposito, 50);
  assert.equal(fail.needs.higiene, 40);
  assert.equal(fail.needs.carinho, 44);
  assert.equal(applyTaskDone(withNeeds({ proposito: 95 }), true, NOW).needs.proposito, 100, "limite de 100");
});

test("sono: só de madrugada e depois de um tempo sem interação", () => {
  const night = new Date(2026, 9, 12, 2, 0, 0);
  const day = new Date(2026, 9, 12, 14, 0, 0);
  const idle = (LIMITS.sleepIdleMinutes + 1) * 60_000;
  assert.equal(isSleepTime(night, idle), true);
  assert.equal(isSleepTime(night, 60_000), false, "interagiu há pouco: fica acordado");
  assert.equal(isSleepTime(day, idle), false);
});

test("avisos: só na entrada num estado de necessidade e respeitando a meia hora", () => {
  assert.equal(alertDue("parado", "fome", 0, NOW), true);
  assert.equal(alertDue("fome", "fome", 0, NOW), false, "não repete enquanto continua no estado");
  assert.equal(alertDue("parado", "entediado", 0, NOW), false, "tédio não gera aviso");
  assert.equal(alertDue("parado", "feliz", 0, NOW), false);
  assert.equal(alertDue("parado", "triste", NOW - 1000, NOW), false, "dentro do tempo de espera");
  assert.equal(alertDue("parado", "triste", NOW - ALERT_COOLDOWN_MS, NOW), true);
  for (const state of ["fome", "raiva", "triste", "entediado"]) assert.equal(needsCare(state), true);
  for (const state of ["parado", "feliz", "musica", "dormindo"]) assert.equal(needsCare(state), false);
});

test("persona: cada mascote tem voz própria, em português, sem vazar regras", () => {
  const prompts = PET_IDS.map((id) => personaInstructions(id));
  assert.equal(new Set(prompts).size, 3);
  PET_IDS.forEach((id, index) => {
    assert.ok(prompts[index].includes(PROFILES[id].nome));
    assert.match(prompts[index], /português do Brasil/);
    assert.match(prompts[index], /não execute comandos/);
    const task = taskInstructions(id);
    assert.ok(task.includes(PROFILES[id].nome));
    assert.match(task, /Modo tarefa/);
    assert.doesNotMatch(task, /não execute comandos/, "tarefa não herda a regra só-conversa");
  });
  assert.match(taskInstructions("work"), /aprovação/);
  assert.match(taskInstructions("tick"), /não altera nada/i);
});

test("persona: a linha de estado traz humor, necessidades e música", () => {
  const line = stateLine("fome", freshPet(NOW).needs, "Daft Punk");
  assert.match(line, /Com fome/);
  assert.match(line, /Fome 80/);
  assert.match(line, /Daft Punk/);
  assert.match(stateLine("parado", freshPet(NOW).needs, ""), /nenhuma/);
});

// ---- Memória e eventos especiais ----
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();
const HOUR = 3_600_000;

test("memória: dias e ausência", () => {
  assert.equal(dayKey(at(2026, 3, 9)), "2026-03-09");
  assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1);
  assert.equal(daysBetween("2026-03-01", "2026-03-01"), 0);
  assert.equal(absenceOf(NOW, NOW + (ABSENCE_MIN_HOURS - 1) * HOUR), "nenhuma");
  assert.equal(absenceOf(NOW, NOW + ABSENCE_MIN_HOURS * HOUR), "ontem");
  assert.equal(absenceOf(NOW, NOW + 47 * HOUR), "ontem");
  assert.equal(absenceOf(NOW, NOW + 3 * 24 * HOUR), "dias");
  assert.equal(absenceOf(NOW, NOW + 8 * 24 * HOUR), "semana");
});

test("memória: sequência de dias aumenta, mantém e reinicia", () => {
  let memory = freshMemory(at(2026, 5, 1));
  assert.equal(memory.streak, 1);
  memory = touch(memory, at(2026, 5, 1, 18), "cuidado").memory;
  assert.equal(memory.streak, 1, "mesmo dia não soma");
  memory = touch(memory, at(2026, 5, 2, 9), "cuidado").memory;
  assert.equal(memory.streak, 2, "dia seguinte soma");
  memory = touch(memory, at(2026, 5, 3, 9), "conversa").memory;
  assert.equal(memory.streak, 3);
  memory = touch(memory, at(2026, 5, 6, 9), "cuidado").memory;
  assert.equal(memory.streak, 1, "pular dias reinicia");
});

test("memória: contadores por tipo de interação e voltar depois de sumir", () => {
  let memory = freshMemory(NOW);
  for (const kind of ["cuidado", "cuidado", "conversa", "tarefa", "tarefa_falha"]) memory = touch(memory, NOW + 1000, kind).memory;
  assert.deepEqual([memory.cares, memory.chats, memory.tasksDone, memory.tasksFailed], [2, 1, 1, 1]);
  const back = touch(freshMemory(NOW), NOW + 30 * HOUR, "cuidado");
  assert.equal(back.returned, "ontem", "voltou depois de mais de 8 h");
  assert.equal(touch(back.memory, NOW + 30 * HOUR + 1000, "cuidado").returned, "nenhuma", "só cobra uma vez");
  assert.equal(back.memory.lastSeenAt, NOW + 30 * HOUR);
});

test("marcos: disparam uma vez só, no número certo", () => {
  let memory = freshMemory(NOW);
  const seen = [];
  for (let i = 0; i < 12; i += 1) {
    const result = touch(memory, NOW + (i + 1) * 1000, "tarefa");
    memory = result.memory;
    seen.push(...result.milestones.map((m) => m.id));
  }
  assert.deepEqual(seen, ["tarefas10"]);
  const later = touch(memory, NOW + 20_000, "tarefa");
  assert.deepEqual(later.milestones, [], "não repete");
  const week = touch(freshMemory(at(2026, 1, 1)), at(2026, 1, 9), "cuidado");
  assert.ok(week.milestones.some((m) => m.id === "juntos7"));
  assert.equal(daysTogether(week.memory, at(2026, 1, 9)), 8);
  let streaky = freshMemory(at(2026, 1, 1));
  const ids = [];
  for (let day = 1; day <= 8; day += 1) {
    const result = touch(streaky, at(2026, 1, day), "cuidado");
    streaky = result.memory;
    ids.push(...result.milestones.map((m) => m.id));
  }
  assert.ok(ids.includes("streak3") && ids.includes("streak7") && ids.includes("juntos7"));
});

test("aniversário: só no dia do encontro, depois de um ano, uma vez por ano", () => {
  const memory = freshMemory(at(2025, 10, 12));
  assert.equal(anniversaryDue(memory, at(2025, 10, 12)), 0, "no primeiro dia não é aniversário");
  assert.equal(anniversaryDue(memory, at(2026, 10, 11)), 0);
  assert.equal(anniversaryDue(memory, at(2026, 10, 12)), 1);
  assert.equal(anniversaryDue({ ...memory, anniversaryYear: 2026 }, at(2026, 10, 12)), 0, "já comemorado neste ano");
  assert.equal(anniversaryDue(memory, at(2027, 10, 12)), 2);
});

test("evento diário: um por dia, presente de dia e comentário de madrugada só com o usuário ativo", () => {
  const memory = freshMemory(at(2026, 6, 1));
  const always = () => 0;
  const never = () => 0.99;
  assert.equal(dailyEventDue(memory, at(2026, 6, 2, 14), false, always), "presente");
  assert.equal(dailyEventDue(memory, at(2026, 6, 2, 14), false, never), null);
  assert.equal(dailyEventDue(memory, at(2026, 6, 2, 3), true, always), "madrugada");
  assert.equal(dailyEventDue(memory, at(2026, 6, 2, 3), false, always), null, "madrugada exige usuário ativo");
  assert.equal(dailyEventDue(memory, at(2026, 6, 2, 22), true, always), null, "fora das janelas");
  assert.equal(dailyEventDue({ ...memory, eventDay: "2026-06-02" }, at(2026, 6, 2, 14), true, always), null, "já teve evento hoje");
});

test("cuidar não apaga a memória do mascote", () => {
  const pet = { ...withNeeds({ fome: 20 }), memory: { ...freshMemory(NOW), streak: 5, tasksDone: 9 } };
  const result = applyCare(pet, "comer", NOW);
  assert.equal(result.data.memory.streak, 5);
  assert.equal(result.data.memory.tasksDone, 9);
  assert.equal(applyTaskDone(pet, true, NOW).memory.streak, 5);
  assert.equal(advance(pet, tick, 1, 0, 0).memory.tasksDone, 9);
  assert.equal(advanceOffline(pet, tick, 5).memory.tasksDone, 9);
});

test("falas de memória: todo mascote cobre todos os eventos, com marcador trocado", () => {
  for (const id of PET_IDS) {
    for (const key of ["reencontro", "marco", "aniversario", "presente", "madrugada"]) assert.ok(LINES[id][key].length >= 2, `${id}.${key}`);
    for (const away of ["ontem", "dias", "semana"]) {
      assert.ok(LINES[id].saudade[away].length >= 1);
      assert.ok(absenceLine(id, away).length > 0);
    }
    const marco = eventLine(id, "marco", { marco: "7 dias seguidos" }, () => 0);
    assert.ok(marco.includes("7 dias seguidos") && !marco.includes("{"));
    assert.ok(!eventLine(id, "aniversario", { anos: 3 }, () => 0).includes("{anos}"));
  }
  assert.match(absenceLine("tick", "ontem", () => 0), /ontem/i, "o Tick cita o ontem");
  assert.ok(Object.keys(EVENT_TITLE).length >= 6);
});

test("resumo para o Codex traz convivência, sequência, conquistas e ausência", () => {
  const memory = { ...freshMemory(at(2026, 1, 1)), streak: 4, tasksDone: 7, chats: 3, lastSeenAt: at(2026, 1, 10) };
  const note = memorySummary(memory, at(2026, 1, 12));
  assert.match(note, /há 11 dia/);
  assert.match(note, /sequência atual de 4/);
  assert.match(note, /7 tarefa/);
  assert.match(note, /sem aparecer por cerca de 2 dia/);
  assert.doesNotMatch(memorySummary({ ...memory, lastSeenAt: at(2026, 1, 12) }, at(2026, 1, 12)), /sem aparecer/);
  assert.match(stateLine("parado", freshPet(NOW).needs, "", "Vocês se conhecem há 3 dia(s)"), /Memória: Vocês se conhecem há 3/);
});

// --- Ausência por falta de tokens ---------------------------------------------------------------
const wall = (hour, minute = 0, day = 14) => new Date(2026, 9, day, hour, minute).getTime(); // 14/10/2026 é quarta
const hoursAfter = (time, hours) => time + hours * 3_600_000;
const codexUsage = (windows, status = "ok", id = "codex") => [{ id, status, windows }];

test("ausência: só janela do motor dos mascotes esgotada bloqueia", () => {
  const now = wall(12);
  const reset = new Date(hoursAfter(now, 2)).toISOString();
  assert.equal(usageBlock(codexUsage([{ usedPercent: 60, resetsAt: reset }]), now), null);
  assert.equal(usageBlock(codexUsage([{ usedPercent: 100, resetsAt: reset }], "ok", "claude"), now), null);
  assert.equal(usageBlock(codexUsage([{ usedPercent: 100, resetsAt: reset }], "error"), now), null);
  assert.deepEqual(usageBlock(codexUsage([{ usedPercent: 100, resetsAt: reset }]), now), { until: Date.parse(reset) });
});

test("ausência: com duas janelas esgotadas volta na mais tardia; janela vencida no cache não bloqueia", () => {
  const now = wall(12);
  const soon = new Date(hoursAfter(now, 1)).toISOString();
  const late = new Date(hoursAfter(now, 50)).toISOString();
  assert.equal(usageBlock(codexUsage([{ usedPercent: 100, resetsAt: soon }, { usedPercent: 99.5, resetsAt: late }]), now).until, Date.parse(late));
  assert.equal(usageBlock(codexUsage([{ usedPercent: 100, resetsAt: new Date(now - 60_000).toISOString() }]), now), null);
  assert.deepEqual(usageBlock(codexUsage([{ usedPercent: 100, resetsAt: null }]), now), { until: null });
});

test("ausência: reconhece erro de limite de uso, mas não limite de ritmo", () => {
  assert.equal(isUsageLimit("usageLimitExceeded"), true);
  assert.equal(isUsageLimit(undefined, "You've hit your usage limit. Try again later."), true);
  assert.equal(isUsageLimit("rateLimitExceeded", "Too many requests"), false);
  assert.equal(isUsageLimit(undefined, "Erro do Codex."), false);
});

test("ausência: o motivo vem da hora em que saíram", () => {
  const cases = [
    [wall(23), 7, "noite"], [wall(3), 4, "noite"], [wall(7), 1, "cafe"], [wall(12, 10), 1.5, "almoco"],
    [wall(16), 1, "lanche"], [wall(19), 2, "jantar"], [wall(10), 1, "geral"], [wall(10, 0, 17), 1, "fimdesemana"],
  ];
  for (const [now, hours, reason] of cases) assert.equal(pickReason(new Date(now), hoursAfter(now, hours)), reason);
});

test("ausência: almoço de várias horas não existe; sumiço longo vira férias", () => {
  const lunch = wall(12, 10);
  assert.equal(pickReason(new Date(lunch), hoursAfter(lunch, 5)), "geral");
  assert.equal(pickReason(new Date(lunch), hoursAfter(lunch, 72)), "ferias");
  assert.equal(pickReason(new Date(wall(23)), hoursAfter(wall(23), 30)), "ferias");
  assert.equal(pickReason(new Date(wall(23)), null), "noite");
  assert.equal(pickReason(new Date(lunch), null), "almoco");
});

test("ausência: o horário da volta é falado em português", () => {
  const now = wall(12);
  assert.equal(returnLabel(wall(14, 5), now), "às 14:05");
  assert.equal(returnLabel(wall(8, 0, 15), now), "amanhã às 08:00");
  assert.equal(returnLabel(wall(8, 0, 17), now), "sábado às 08:00");
  assert.equal(returnLabel(null, now), "quando der");
  assert.equal(returnLabel(now - 1000, now), "às 12:00");
});

test("ausência: todo mascote tem desculpa em todo motivo, sempre com a hora da volta", () => {
  for (const id of PET_IDS) {
    for (const reason of AWAY_REASON_LIST) {
      const lines = EXCUSES[id][reason];
      assert.ok(lines.length >= 2, `${id}/${reason}`);
      for (const line of lines) assert.ok(line.includes("{volta}"), `${id}/${reason}: ${line}`);
    }
    assert.ok(RETURN_LINES[id].length >= 3);
  }
});

test("ausência: a desculpa é estável, em personagem e mostra a volta", () => {
  const now = wall(12, 10);
  const away = newAway(now, hoursAfter(now, 1.5), "usage", () => 0.5);
  assert.equal(away.reason, "almoco");
  for (const id of PET_IDS) {
    const first = excuseLine(id, away, now);
    assert.equal(excuseLine(id, away, now), first);
    assert.ok(first.includes("às 13:40"), first);
    assert.ok(!first.includes("{volta}"));
  }
  assert.notEqual(excuseLine("tick", away, now), excuseLine("work", away, now));
  assert.ok(RETURN_LINES.papo.includes(returnLine("papo")));
});

test("ausência: voltar de comida ou sono faz bem; ficar fora sem motivo não dá nada", () => {
  assert.ok(returnBoost("almoco").fome > 0);
  assert.ok(returnBoost("noite").carinho > 0);
  assert.deepEqual(returnBoost("geral"), {});
});

// --- Orçamento de tokens ------------------------------------------------------------------------
test("orçamento: raciocínio baixo para Tick, Papo e conversa; o Work herda o padrão", () => {
  assert.deepEqual(effortFor("tick"), { effort: "low" });
  assert.deepEqual(effortFor("papo"), { effort: "low" });
  assert.deepEqual(effortFor("work"), {});
  assert.deepEqual(effortFor("work", true), { effort: "low" });
  assert.deepEqual(effortFor(undefined), {});
});

test("orçamento: contexto repetido não é reenviado e o resumo só vai ao trocar de agente", () => {
  assert.equal(contextToSend("tarefas", undefined), "tarefas");
  assert.equal(contextToSend("tarefas", "tarefas"), "");
  assert.equal(contextToSend("tarefas novas", "tarefas"), "tarefas novas");
  assert.equal(contextToSend("", "tarefas"), "");
  assert.equal(needsShared(false, false), false);
  assert.equal(needsShared(true, false), true);
  assert.equal(needsShared(false, true), true);
});

test("orçamento: textos longos são cortados e os limites são razoáveis", () => {
  assert.equal(clip("curto", 10), "curto");
  assert.equal(clip("a".repeat(50), 10).length, 10);
  assert.ok(clip("a".repeat(50), 10).endsWith("…"));
  assert.ok(CONTEXT.recentMessages * CONTEXT.recentLength <= 2_500);
  assert.ok(MAX_THREAD_TURNS >= 6 && MAX_THREAD_TURNS <= 20);
});

test("persona: a conversa pede respostas de até 2 frases", () => {
  assert.ok(personaInstructions("tick").includes("no máximo 2 frases"));
});
