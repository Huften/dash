import chimeUrl from './assets/sounds/chime.wav';
import cashUrl from './assets/sounds/cash.wav';
import pingUrl from './assets/sounds/ping.wav';
import dropletUrl from './assets/sounds/droplet.wav';
import marimbaUrl from './assets/sounds/marimba.wav';

// Peon mode sounds (Warcraft 3 easter egg)
import peonReady1 from './assets/sounds/peon/PeonReady1.ogg';
import peonWhat1 from './assets/sounds/peon/PeonWhat1.ogg';
import peonWhat3 from './assets/sounds/peon/PeonWhat3.ogg';
import peonWhat4 from './assets/sounds/peon/PeonWhat4.ogg';
import peonYes1 from './assets/sounds/peon/PeonYes1.ogg';
import peonYes2 from './assets/sounds/peon/PeonYes2.ogg';
import peonYes3 from './assets/sounds/peon/PeonYes3.ogg';
import peonYes4 from './assets/sounds/peon/PeonYes4.ogg';

// Rammus mode sounds (League of Legends)
import rammusOk1 from './assets/sounds/rammus/Ok1.ogg';
import rammusOk2 from './assets/sounds/rammus/Ok2.ogg';
import rammusOk3 from './assets/sounds/rammus/Ok3.ogg';
import rammusYeah1 from './assets/sounds/rammus/Yeah1.ogg';
import rammusAlright1 from './assets/sounds/rammus/Alright1.ogg';
import rammusHmm1 from './assets/sounds/rammus/Hmm1.ogg';

export const NOTIFICATION_SOUNDS = [
  'off',
  'chime',
  'cash',
  'ping',
  'droplet',
  'marimba',
  'peon',
  'rammus',
] as const;
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];

export const SOUND_LABELS: Record<NotificationSound, string> = {
  off: 'Off',
  chime: 'Chime',
  cash: 'Cash Register',
  ping: 'Ping',
  droplet: 'Droplet',
  marimba: 'Marimba',
  peon: 'Peon',
  rammus: 'Rammus',
};

/** Theme sounds are sound packs with event-specific voicelines. */
export const THEME_SOUNDS: NotificationSound[] = ['peon', 'rammus'];

export type ThemeEvent = 'ready' | 'what' | 'yes';

const SIMPLE_URLS: Record<string, string> = {
  chime: chimeUrl,
  cash: cashUrl,
  ping: pingUrl,
  droplet: dropletUrl,
  marimba: marimbaUrl,
};

const THEME_SOUND_MAP: Record<string, Record<ThemeEvent, string[]>> = {
  peon: {
    ready: [peonReady1],
    what: [peonWhat1, peonWhat3, peonWhat4],
    yes: [peonYes1, peonYes2, peonYes3, peonYes4],
  },
  rammus: {
    ready: [rammusOk1, rammusOk2, rammusOk3], // task complete → "OK"
    what: [rammusHmm1], // task created → "Hmm"
    yes: [rammusYeah1, rammusAlright1], // user submits query → "Yeah" / "Alright"
  },
};

const cache = new Map<string, HTMLAudioElement>();

function playUrl(url: string): void {
  let audio = cache.get(url);
  if (!audio) {
    audio = new Audio(url);
    cache.set(url, audio);
  }
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

export function isThemeSound(sound: NotificationSound): boolean {
  return THEME_SOUNDS.includes(sound);
}

export function playThemeSound(sound: NotificationSound, event: ThemeEvent): void {
  const map = THEME_SOUND_MAP[sound];
  if (!map) return;
  const sounds = map[event];
  const url = sounds[Math.floor(Math.random() * sounds.length)];
  playUrl(url);
}

/** @deprecated Use playThemeSound('peon', event) instead */
export function playPeonSound(event: ThemeEvent): void {
  playThemeSound('peon', event);
}

export function playNotificationSound(sound: NotificationSound): void {
  if (sound === 'off') return;
  if (isThemeSound(sound)) {
    playThemeSound(sound, 'ready');
    return;
  }
  const url = SIMPLE_URLS[sound];
  if (url) playUrl(url);
}
