import type { PetId } from "./data.ts";

const TERMS: Record<PetId, string[]> = {
  tick: [
    "agenda", "agendar", "calendário", "calendario", "compromisso", "data", "hora", "horário", "horario",
    "lembrete", "prazo", "rotina", "tempo", "tarefa", "clima", "previsão", "previsao", "organizar", "planejar",
  ],
  papo: [
    "mensagem", "responder", "resposta", "escrever", "texto", "whatsapp", "notificação", "notificacao", "copiar",
    "clipboard", "comunicar", "email", "e-mail", "conversa", "contato", "avisar", "publicar", "resumir",
  ],
  work: [
    "código", "codigo", "arquivo", "pasta", "projeto", "erro", "bug", "terminal", "comando", "aplicativo", "app",
    "plugin", "instalar", "configurar", "linux", "git", "teste", "build", "api", "banco", "dados", "script", "site",
  ],
};

const normalize = (text: string) => text.toLocaleLowerCase("pt-BR");

const DATE_INTENT = /\b(?:hoje|amanhã|amanha|ontem|anteontem|data|datas|dia|dias|semana|semanas|mês|mes|meses|ano|anos|feriado|feriados|calendário|calendario|agenda|agendar|agendamento|aniversário|aniversario|prazo|prazos|segunda(?:-feira)?|terça(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sábado|sabado|domingo|janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b|\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b/;

/** Menção nominal sempre vence preferências anteriores e a classificação por assunto. */
export function mentionedPet(text: string): PetId | null {
  const body = normalize(text);
  if (/(?:^|\s)@?tick\b/.test(body)) return "tick";
  if (/(?:^|\s)@?papo\b/.test(body)) return "papo";
  if (/(?:^|\s)@?work\b/.test(body)) return "work";
  return null;
}

/** Escolhe o agente pela intenção explícita; empates e pedidos técnicos genéricos ficam com Work. */
export function routePet(text: string): PetId {
  const body = normalize(text);
  const mentioned = mentionedPet(body);
  if (mentioned) return mentioned;
  // Datas são domínio exclusivo do Tick, mesmo quando o pedido também menciona código, arquivos ou mensagens.
  if (DATE_INTENT.test(body)) return "tick";
  const score = Object.fromEntries((Object.keys(TERMS) as PetId[]).map((id) => [id, TERMS[id].reduce((sum, term) => sum + (body.includes(term) ? 1 : 0), 0)])) as Record<PetId, number>;
  const best = Math.max(score.tick, score.papo, score.work);
  if (best === 0) return "work";
  if (score.work === best) return "work";
  return score.papo === best ? "papo" : "tick";
}
