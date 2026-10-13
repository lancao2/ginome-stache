import { ref } from "vue";

// A apresentação dos mascotes aparece uma vez por versão; "Rever apresentação" a chama de novo.
export const INTRO_VERSION = "1.1.0";
const KEY = "stache.intro";

const open = ref(false);
// Ao fechar, o usuário pediu para ver os mascotes (abre a aba deles).
const goToPets = ref(false);

function shouldAutoShow(): boolean {
  try { return localStorage.getItem(KEY) !== INTRO_VERSION; }
  catch { return false; } // sem armazenamento não dá para lembrar: melhor não repetir sempre
}

function markSeen() {
  try { localStorage.setItem(KEY, INTRO_VERSION); }
  catch { /* sem armazenamento: aparece só nesta sessão */ }
}

function start() {
  markSeen();
  goToPets.value = false;
  open.value = true;
}

function finish(showPets = false) {
  goToPets.value = showPets;
  open.value = false;
}

export function usePetsIntro() {
  return { open, goToPets, shouldAutoShow, start, finish };
}
