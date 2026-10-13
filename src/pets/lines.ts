// Falas de memória e de eventos especiais, por mascote. {marco} e {anos} são trocados na hora.
import type { PetId } from "./data.ts";
import type { AbsenceClass } from "./memory.ts";

export type EventKind = "saudade" | "reencontro" | "marco" | "aniversario" | "presente" | "madrugada";

interface PetLines {
  saudade: Record<Exclude<AbsenceClass, "nenhuma">, string[]>;
  reencontro: string[];
  marco: string[];
  aniversario: string[];
  presente: string[];
  madrugada: string[];
}

export const LINES: Record<PetId, PetLines> = {
  tick: {
    saudade: {
      ontem: ["Você me esqueceu ontem. Eu anotei. Eu sempre anoto.", "Ontem: zero tarefas planejadas. Tudo bem… não, não está."],
      dias: ["Alguns dias sem agenda e sem você. O cronograma sente.", "Contei cada dia. Foram vários. Tic. Tac."],
      semana: ["Mais de uma semana! Meus ponteiros até enferrujaram de espera.", "Uma semana inteira sem planejar nada. Eu quase me desorganizei."],
    },
    reencontro: ["Você voltou! Pontualidade perdoa quase tudo.", "Finalmente. Já ia remarcar a saudade."],
    marco: ["Marco no calendário: {marco}! Isso merece um chá.", "{marco}. Eu sabia que a rotina ia pegar."],
    aniversario: ["{anos} ano(s) de cronograma juntos! Dia riscado em vermelho no calendário.", "Aniversário de {anos} ano(s)! Eu já tinha marcado."],
    presente: ["Encontrei um biscoito esquecido na agenda. É seu… quer dizer, meu. Dividimos!", "Sobrou um tempinho no dia e um chá quente. Aproveita comigo!"],
    madrugada: ["Acordado a essa hora? Isso destrói qualquer cronograma.", "Madrugada? Vai dormir. Amanhã você agradece."],
  },
  papo: {
    saudade: {
      ontem: ["Piu… você me esqueceu ontem! Eu fiquei só ouvindo o silêncio.", "Ontem ninguém me contou nada… piu."],
      dias: ["Faz dias que você não aparece! Eu tinha tanta fofoca guardada!", "Piu piu… quanto tempo! Quase esqueci o som da sua voz. Quer dizer, do teclado."],
      semana: ["UMA SEMANA! Eu quase mudei de ninho!", "Mais de uma semana sem papo. Piu… tô até rouco de saudade."],
    },
    reencontro: ["Piu piu! Você voltou! Senta aqui que eu tenho muita coisa pra contar!", "Voltou! Eu sabia, eu sabia, eu sabia!"],
    marco: ["Piu! {marco}! Vou contar pra todo mundo!", "{marco}! Isso vai direto pra minha lista de fofocas boas."],
    aniversario: ["{anos} ano(s) de papo! Piu piu piuuu, parabéns pra gente!", "Aniversário de {anos} ano(s)! Já convidei até os pombos."],
    presente: ["Piu! Achei sementes no parapeito e trouxe pra você… metade é minha.", "Um passarinho me contou que hoje é dia de ganhar um mimo!"],
    madrugada: ["Piu? Você acordado de madrugada… tá com problema? Pode contar pra mim!", "Nem passarinho acorda a essa hora! Conta o que houve."],
  },
  work: {
    saudade: {
      ontem: ["Ontem você sumiu. Eu não senti falta. Muito. Só um pouquinho.", "Passou um dia sem você. Eu aproveitei pra reclamar do sistema sozinho."],
      dias: ["Alguns dias sem aperto nem manutenção. Tô até frouxo.", "Sumiu por dias. Quem vai calibrar as coisas por aqui?"],
      semana: ["Uma semana! Já tinha criado ferrugem no meu humor, que nem existia.", "Mais de uma semana. Eu juro que não senti falta. Pra confirmar, conte até dez."],
    },
    reencontro: ["Hmpf. Voltou. Pelo menos apareceu com o terminal aberto?", "Até que enfim. Não conta pra ninguém que eu fiquei esperando."],
    marco: ["{marco}. Hmpf… até que não foi ruim.", "Marco: {marco}. Anotado no log. Com orgulho, que fique entre nós."],
    aniversario: ["{anos} ano(s) juntos. Eu seguro firme, é o meu trabalho.", "Aniversário de {anos} ano(s). Não vou fazer discurso. Vou só apertar bem forte."],
    presente: ["Achei uma peça sobrando. Serve pra você… ou pra mim. Pra mim.", "Alguém deixou óleo de qualidade por aqui. Hoje eu tô de bom humor."],
    madrugada: ["Madrugada e a máquina ainda ligada? Típico.", "Vai dormir. Eu fico de vigia, que é pra isso que sou feito."],
  },
};

export const EVENT_TITLE: Record<EventKind, string> = {
  saudade: "Sentiu saudade", reencontro: "Reencontro", marco: "Marco", aniversario: "Aniversário", presente: "Presente", madrugada: "Madrugada",
};

function choose(lines: string[], rand: () => number): string {
  return lines[Math.floor(rand() * lines.length)] ?? lines[0];
}

export function eventLine(pet: PetId, kind: Exclude<EventKind, "saudade">, vars: { marco?: string; anos?: number } = {}, rand: () => number = Math.random): string {
  return choose(LINES[pet][kind], rand).replace("{marco}", vars.marco ?? "").replace("{anos}", String(vars.anos ?? 1));
}

export function absenceLine(pet: PetId, absence: Exclude<AbsenceClass, "nenhuma">, rand: () => number = Math.random): string {
  return choose(LINES[pet].saudade[absence], rand);
}
