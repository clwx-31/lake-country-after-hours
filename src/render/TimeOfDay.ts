// Time-of-day presets: everything the sky, lights, fog and materials need.

export type TimeId = 'golden' | 'day' | 'evening';

export interface TimePreset {
  id: TimeId;
  label: string;
  skyTop: number;
  skyMid: number;
  skyHorizon: number;
  horizonGlow: number;
  sunDir: [number, number, number]; // toward the sun
  sunColor: number;
  sunIntensity: number;
  sunDisk: number; // 0 hides the sun disk (moon instead at night)
  stars: number;
  fog: number;
  fogDensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  exposure: number;
  windowLight: number;
  wetness: number;
  lamps: number; // pooled street-light intensity
  headlights: number;
  bloom: number;
  shadows: boolean;
}

export const TIMES: Record<TimeId, TimePreset> = {
  golden: {
    id: 'golden', label: 'Golden hour',
    skyTop: 0x3c6aa8, skyMid: 0x8eb3d6, skyHorizon: 0xf0b070, horizonGlow: 0xffa050,
    sunDir: [-0.82, 0.16, 0.35], sunColor: 0xffc27a, sunIntensity: 3.1, sunDisk: 1, stars: 0,
    fog: 0xd6b18a, fogDensity: 0.00055,
    hemiSky: 0xa8c4e4, hemiGround: 0x5c4630, hemiIntensity: 0.85, exposure: 0.92,
    windowLight: 0.3, wetness: 0, lamps: 0, headlights: 18, bloom: 0.3, shadows: true,
  },
  day: {
    id: 'day', label: 'Daytime',
    skyTop: 0x3a78cc, skyMid: 0x89bdea, skyHorizon: 0xd6e5f0, horizonGlow: 0xffffff,
    sunDir: [0.35, 0.82, 0.3], sunColor: 0xfff3dd, sunIntensity: 3.3, sunDisk: 1, stars: 0,
    fog: 0xc6d7e6, fogDensity: 0.00042,
    hemiSky: 0xb9d5f2, hemiGround: 0x6a5a40, hemiIntensity: 0.95, exposure: 0.82,
    windowLight: 0, wetness: 0, lamps: 0, headlights: 0, bloom: 0.15, shadows: true,
  },
  evening: {
    id: 'evening', label: 'Evening after rain',
    skyTop: 0x060a1a, skyMid: 0x121a36, skyHorizon: 0x4a3030, horizonGlow: 0x8a4a14,
    sunDir: [-0.4, 0.55, -0.7], sunColor: 0x9db4e8, sunIntensity: 0.55, sunDisk: 0, stars: 1,
    fog: 0x141b2c, fogDensity: 0.0019,
    hemiSky: 0x5a6f9e, hemiGround: 0x1a140e, hemiIntensity: 0.75, exposure: 1.05,
    windowLight: 1, wetness: 1, lamps: 28, headlights: 70, bloom: 0.55, shadows: false,
  },
};

export const TIME_ORDER: TimeId[] = ['golden', 'day', 'evening'];
