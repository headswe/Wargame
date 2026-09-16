/** One place for every colour, so the game reads as a single object. */
export const THEME = {
  ground: 0x8b8275,
  groundDark: 0x6f6759,
  wall: 0x6d685f,
  wallTop: 0x837d73,
  lowCover: 0x9a8b6a,
  door: 0x5a544b,

  player: 0x9fb7c4,
  playerAccent: 0x4fd2e0,
  hostile: 0xb05b48,
  hostileAccent: 0xff6a4d,

  downed: 0x6a5a55,
  dead: 0x3b3330,

  tracerPlayer: 0xffe9a8,
  tracerHostile: 0xff9d6a,
  impact: 0xd8cdb4,
  blood: 0xc0392b,

  objective: 0xf2c14e,
  coverPip: 0x5ad6b0,
  coverPipWeak: 0xd6b45a,
  suppressed: 0xff5c5c,

  sky: 0xb9c4cc,
  sun: 0xfff2df,

  /**
   * The air, and what the ground dissolves into at the far edge.
   *
   * Without it the map ended in a cliff with a black void under it, which read
   * as a model on a table rather than as ground going on past where you can
   * see. A haze the colour of a cold overcast morning is also most of what
   * gives an isometric view any depth at all: near things read as near because
   * far things are washed out, and nothing else in this projection says so.
   */
  haze: 0x2c3330,
  hazeLit: 0x424a44,
} as const;

/** Slight per-tile lightness variation so large wall runs do not look printed. */
export function tileJitter(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}
