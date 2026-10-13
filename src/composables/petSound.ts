export type PetSoundKind = "greet" | "pop";

// Sons curtos da apresentação dos mascotes, em public/sound.
const FILES: Record<PetSoundKind, string> = { greet: "pets-greet.wav", pop: "pets-pop.wav" };
const VOLUME: Record<PetSoundKind, number> = { greet: 0.9, pop: 0.6 };

// Cada toque usa um elemento próprio, guardado até terminar, para o coletor de lixo não cortar o som.
const playing = new Set<HTMLAudioElement>();

export function playPetSound(kind: PetSoundKind) {
  const audio = new Audio(`/sound/${FILES[kind]}`);
  audio.volume = VOLUME[kind];
  playing.add(audio);
  const release = () => playing.delete(audio);
  audio.addEventListener("ended", release);
  audio.addEventListener("error", release);
  audio.play().catch((error) => { release(); console.warn("Stache não conseguiu tocar o som do mascote", error); });
}
