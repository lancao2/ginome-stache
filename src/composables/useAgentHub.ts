import { ref } from "vue";
import type { PetId } from "../pets/data";

const preferredPet = ref<PetId | null>(null);

export function useAgentHub() {
  return {
    preferredPet,
    openConversation(pet: PetId) { preferredPet.value = pet; },
    consumePreference() {
      const pet = preferredPet.value;
      preferredPet.value = null;
      return pet;
    },
    clearPreference() { preferredPet.value = null; },
  };
}
