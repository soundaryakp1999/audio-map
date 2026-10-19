// Vibration patterns that match the sound cues, for noisy streets and for people who cannot hear them.
// ponytail: iOS Safari has no vibration API; those phones simply get no buzz.

const PATTERNS: Record<string, number[]> = {
  left: [250],
  right: [80, 80, 80],
  'Steps': [40, 40, 40, 40, 40, 40, 40],
  'Pedestrian crossing': [60, 60, 60],
  'Crossing with signals': [60, 60, 60, 60, 60],
  'Railway crossing': [300, 100, 300],
  'Unlit path': [500],
  wrongWay: [150, 80, 150, 80, 150],
  deadEnd: [400, 100, 400],
  arrival: [100, 50, 100, 50, 300],
};

export function pattern(kind: string): number[] | undefined {
  return PATTERNS[kind];
}

export function buzz(kind: string) {
  const p = pattern(kind);
  if (p && typeof navigator !== 'undefined') navigator.vibrate?.(p);
}
