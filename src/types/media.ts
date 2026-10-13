export interface MediaTrack {
  title: string;
  artist: string;
  album: string;
  accent: string;
  duration: number;
  position: number;
  artwork: string | null;
  source: string;
  canGoNext: boolean;
  canGoPrevious: boolean;
}

export interface MediaState {
  active: boolean;
  playing: boolean;
  track: MediaTrack | null;
}
