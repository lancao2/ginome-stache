// Dados dos mascotes: identidade, temperamento (taxas de decaimento) e falas.
// O motor de IA de todos é o Codex; o Claude fica fora por enquanto.

export const PET_IDS = ["tick", "papo", "work"] as const;
export type PetId = (typeof PET_IDS)[number];

export const NEEDS = ["fome", "diversao", "higiene", "carinho", "proposito"] as const;
export type NeedId = (typeof NEEDS)[number];

export type PetState =
  | "parado" | "pensando" | "fome" | "raiva" | "entediado" | "triste" | "feliz" | "musica"
  | "dormindo" | "comendo" | "banho" | "brincando" | "trabalhando" | "falando";

export type CareAction = "comer" | "brincar" | "banho" | "conversar";

/** Motor de IA dos agentes. Todos usam o Codex; o Claude volta quando for liberado. */
export const PET_ENGINE = "codex" as const;

export const NEED_LABEL: Record<NeedId, string> = {
  fome: "Fome", diversao: "Diversão", higiene: "Higiene", carinho: "Carinho", proposito: "Propósito",
};

export const STATE_LABEL: Record<PetState, string> = {
  parado: "Tranquilo", pensando: "Pensando", fome: "Com fome", raiva: "Com raiva", entediado: "Entediado",
  triste: "Triste", feliz: "Feliz", musica: "Curtindo música", dormindo: "Dormindo", comendo: "Comendo",
  banho: "Tomando banho", brincando: "Brincando", trabalhando: "Trabalhando", falando: "Falando",
};

export const CARE_LABEL: Record<CareAction, string> = {
  comer: "Alimentar", brincar: "Brincar", banho: "Dar banho", conversar: "Conversar",
};

export interface PetProfile {
  id: PetId;
  nome: string;
  especie: string;
  papel: string;
  resumo: string;
  /** Fala de apresentação na animação da versão 1.1.0. */
  apresentacao: string;
  engine: typeof PET_ENGINE;
  /** Necessidade que, quando crítica, deixa o mascote com raiva (e que reage aos sinais do sistema). */
  irritante: NeedId;
  /** Multiplicadores da taxa-base de decaimento: o temperamento do mascote. */
  taxas: Record<NeedId, number>;
  /** Palavras (título, artista, álbum, fonte) que ele gosta de ouvir. */
  gosta: string[];
  comida: { nome: string; emoji: string };
  brincadeira: { nome: string; emoji: string };
  falas: Partial<Record<PetState, string[]>> & { parado: string[]; cheio: string[]; cooldown: string[]; recusa: string[] };
}

export const PROFILES: Record<PetId, PetProfile> = {
  tick: {
    id: "tick",
    nome: "Tick",
    especie: "Forma azul",
    papel: "Tempo e rotina",
    resumo: "Tarefas, agenda e clima. Pontual, perfeccionista e ansioso: não perdoa atrasos, mas é gentil com quem se esforça.",
    apresentacao: "Oi! Eu cuido do seu tempo: tarefas, agenda e clima. Pontualidade é tudo!",
    engine: PET_ENGINE,
    irritante: "proposito",
    taxas: { fome: 1, diversao: 1.25, higiene: 0.9, carinho: 0.9, proposito: 1.3 },
    gosta: ["lofi", "lo-fi", "instrumental", "piano", "clássic", "classic", "jazz", "podcast", "ambient"],
    comida: { nome: "Chá com biscoito", emoji: "🍵" },
    brincadeira: { nome: "Quebra-cabeça", emoji: "🧩" },
    falas: {
      parado: ["Tudo no horário. Do jeito que eu gosto.", "Faltam poucos minutos para o próximo compromisso, vamos?"],
      pensando: ["Calculando o melhor encaixe na agenda…"],
      fome: ["Meu estômago não respeita o relógio…", "Está na hora do chá. Está sempre na hora do chá."],
      raiva: ["Tarefa atrasada! De novo!", "Eu avisei. Eu sempre aviso."],
      entediado: ["Tic… tac… tic… tac… nada acontece.", "Dá pra marcar alguma coisa? Qualquer coisa?"],
      triste: ["Sem ânimo para planejar o dia…", "Acho que eu não dou conta hoje."],
      feliz: ["Dia organizado, energia lá em cima!", "Cada coisa no seu lugar. Perfeito!"],
      musica: ["Esse ritmo cabe certinho no compasso.", "Podia durar o dia inteiro."],
      dormindo: ["Zzz… pontual até dormindo…"],
      comendo: ["Chá na temperatura certa. Obrigado!"],
      banho: ["Sem bolhas fora da linha, por favor."],
      brincando: ["Quase… só mais uma peça!"],
      trabalhando: ["Em andamento. Não me atrase."],
      falando: ["Anotado."],
      cheio: ["Já tomei meu chá no horário, obrigado."],
      cooldown: ["Ainda não está na hora. Respeite o cronograma."],
      recusa: ["Não consigo planejar nada assim. Me dá um chá e um tempo, por favor.", "Desse jeito vou errar o cronograma. Cuida de mim primeiro?"],
    },
  },
  papo: {
    id: "papo",
    nome: "Papo",
    especie: "Triângulo amarelo",
    papel: "Comunicação",
    resumo: "WhatsApp, notificações e área de transferência. Carinhoso, curioso e carente: fica magoado quando é ignorado.",
    apresentacao: "Oi, oi! Eu cuido das suas mensagens, notificações e do que você copia!",
    engine: PET_ENGINE,
    irritante: "carinho",
    taxas: { fome: 1, diversao: 1, higiene: 0.9, carinho: 1.5, proposito: 0.9 },
    gosta: ["pop", "podcast", "mpb", "samba", "sertanej", "acústic", "acoustic", "love"],
    comida: { nome: "Confetes", emoji: "✨" },
    brincadeira: { nome: "Fofoca", emoji: "💬" },
    falas: {
      parado: ["Ei! Sabia que chegou mensagem? Ah, não, era engano.", "Tô aqui, tô aqui! Quer conversar?"],
      pensando: ["Deixa eu ver como respondo isso…"],
      fome: ["Uns confetes, por favor?", "Minha energia está quase vazia!"],
      raiva: ["Você me ignorou o dia todo!", "Nem um oi? NEM UM OI?"],
      entediado: ["Ninguém fala nada… que silêncio chato.", "Alguém me conta uma novidade?"],
      triste: ["Ninguém me escreve mais…", "Fico quietinho aqui no canto."],
      feliz: ["Que dia lindo pra conversar!", "Tenho tanta coisa pra te contar!"],
      musica: ["Eu conheço esse ritmo!", "Aumenta o som, vai!"],
      dormindo: ["Zzz… chi, não conta pra ninguém…"],
      comendo: ["Nham! Obrigado, obrigado!"],
      banho: ["Splash! Pode jogar mais água!"],
      brincando: ["Adivinha o que eu descobri…"],
      trabalhando: ["Já já eu volto com as novidades!"],
      falando: ["Ah, e outra coisa…"],
      cheio: ["Tô cheinho, só se for de papo!"],
      cooldown: ["Calma, deixa eu respirar um pouquinho!"],
      recusa: ["Tô tão tristinho que não consigo ajudar. Faz um carinho?", "Sem ânimo pra mensagens hoje… me dá atenção primeiro?"],
    },
  },
  work: {
    id: "work",
    nome: "Work",
    especie: "Prisma cinza",
    papel: "Máquina e código",
    resumo: "Codex, busca, apps e plugins. Sério por fora, leal por dentro: reclama de tudo, mas faz.",
    apresentacao: "Hmpf. Eu cuido do código e da máquina. Não mexe em nada sem me avisar.",
    engine: PET_ENGINE,
    irritante: "higiene",
    taxas: { fome: 1.2, diversao: 0.9, higiene: 1.4, carinho: 0.8, proposito: 1 },
    gosta: ["rock", "metal", "eletr", "electro", "synth", "techno", "house", "daft", "punk", "soundtrack", "trilha"],
    comida: { nome: "Carga de energia", emoji: "⚡" },
    brincadeira: { nome: "Resolver enigmas", emoji: "🧠" },
    falas: {
      parado: ["Tudo estável. Não mexa em nada.", "Se está funcionando, eu ainda confiro duas vezes."],
      pensando: ["Hmpf. Deixa eu olhar esse erro."],
      fome: ["Minha energia está no limite.", "Carga. Agora. Por favor."],
      raiva: ["Tem erro em tudo e a culpa não é minha!", "Ninguém limpa essa bagunça de logs?"],
      entediado: ["Nada pra resolver. Nada pra revisar. Que tédio.", "Vou conferir os processos só pra passar o tempo."],
      triste: ["Acho que perdi a forma…", "Nem reclamar eu consigo hoje."],
      feliz: ["Tudo alinhado. Não conta pra ninguém que eu gostei.", "Tá… até que tá bom."],
      musica: ["Isso aí tem peso. Aprovado.", "Boa frequência. Aprovada."],
      dormindo: ["Zzz… processando… zzz…"],
      comendo: ["Hmpf… até que essa energia é boa."],
      banho: ["Sem água nos dados… Mas tá gostoso."],
      brincando: ["Não é brincadeira, é teste lógico."],
      trabalhando: ["Processando. Não me interrompa."],
      falando: ["Resumindo:"],
      cheio: ["Já estou com carga completa, valeu."],
      cooldown: ["Espera. Uma coisa de cada vez."],
      recusa: ["Tô sem energia pra mexer em código. Cuida de mim primeiro.", "Sem condição. Recarrega minha energia e depois a gente conversa."],
    },
  },
};

export function pickLine(id: PetId, state: PetState | "cheio" | "cooldown" | "recusa"): string {
  const falas = PROFILES[id].falas;
  const lines = falas[state] ?? falas.parado;
  return lines[Math.floor(Math.random() * lines.length)];
}
