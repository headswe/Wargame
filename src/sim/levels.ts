import { vec } from './math.ts';
import { Fabric } from './world/geometry.ts';
import { Scene } from './world/scene.ts';
import { Surface } from './world/terrain.ts';
import { building, hedgerow, obstacle, revetment } from './world/builder.ts';

export interface LevelDef {
  id: string;
  name: string;
  brief: string;
  size: { width: number; height: number };
  paint: (scene: Scene) => void;
}

export function createScene(level: LevelDef): Scene {
  const scene = new Scene(level.size.width, level.size.height);
  level.paint(scene);
  scene.bake();
  return scene;
}

/**
 * "Stepove" — a village astride a road junction, 170 by 130 metres.
 *
 * The ground does the teaching. Three fireteams start in the south with eighty
 * metres of open field in front of them, rising gently to a low ridge that
 * hides everything beyond it until you are on top of it. A drainage ditch cuts
 * across at an angle, deep enough to crouch in and disappear. A machine gun in
 * the village covers the middle of it all.
 *
 * There is no route that avoids the open — only routes that cross it in
 * shorter pieces, using ground that is genuinely lower than the ground beside
 * it. That distinction is the entire reason for a heightfield.
 */
export const STEPOVE: LevelDef = {
  id: 'stepove',
  name: 'Stepove',
  brief:
    'Client needs the village school cleared and held before dark. Fourteen or so ' +
    'irregulars, a belt-fed covering the open ground, and eighty metres of ploughed ' +
    'field between you and the first building. Use the ditch.',
  size: { width: 170, height: 130 },
  paint: (scene) => {
    const { terrain } = scene;

    // --- ground: gently rolling, with a rise the village sits on and a low
    //     ridge across the approach that makes dead ground behind it.
    terrain.rolling(1.5, 38, 11);
    terrain.mound(vec(92, 40), 70, 4.5);
    terrain.bank([vec(6, 96), vec(70, 92), vec(164, 97)], 24, 3.3);
    terrain.paint(vec(0, 82), vec(170, 130), Surface.Crop);
    terrain.paint(vec(0, 20), vec(170, 70), Surface.Grass);

    // --- the ditch: the one piece of ground you can cross the open inside.
    terrain.cut([vec(14, 84), vec(78, 78), vec(152, 74)], 6.5, 1.7, Surface.Mud);

    // --- the road, riding over the rise rather than cutting through it.
    terrain.road([vec(2, 64), vec(58, 60), vec(120, 58), vec(168, 55)], 7);

    // --- vegetation: the treeline they form up behind, and field hedges.
    hedgerow(scene, [vec(10, 118), vec(56, 116), vec(92, 119)], { radius: 1.7 });
    hedgerow(scene, [vec(104, 117), vec(158, 115)], { radius: 1.7 });
    hedgerow(scene, [vec(8, 103), vec(60, 99), vec(88, 103)]);
    hedgerow(scene, [vec(110, 97), vec(150, 101)]);
    hedgerow(scene, [vec(24, 70), vec(58, 68)], { radius: 1.2 });

    // --- the village
    const houses: [number, number, number, number, number][] = [
      [34, 48, 15, 11, -0.22],
      [61, 43, 13, 10, 0.15],
      [90, 50, 17, 12, -0.08],
      [122, 45, 14, 11, 0.28],
      [148, 52, 12, 10, -0.31],
      [46, 29, 13, 11, 0.19],
      [130, 28, 15, 11, -0.17],
    ];
    for (const [x, y, w, d, angle] of houses) {
      building(scene, {
        centre: vec(x, y), width: w, depth: d, angle,
        openings: [
          { at: 0.62, width: 1.6, kind: 'door' },
          { at: 0.53, width: 1.4, kind: 'window' },
          { at: 0.72, width: 1.4, kind: 'window' },
          { at: 0.12, width: 1.4, kind: 'window' },
        ],
      });
    }

    // --- a walled yard with one way in
    revetment(scene, [vec(68, 26), vec(86, 24), vec(88, 38), vec(70, 40)], Fabric.Brick, 2.2, 1.0);
    revetment(scene, [vec(70, 40), vec(74, 40)], Fabric.Brick, 2.2, 1.0);
    revetment(scene, [vec(72, 30), vec(82, 29)], Fabric.Sandbag);

    // --- the school: the objective, with a real interior to fight through
    building(scene, {
      centre: vec(94, 14), width: 34, depth: 16, angle: 0.06,
      fabric: Fabric.Concrete, wallTop: 3.1, thickness: 1.0,
      openings: [
        { at: 0.60, width: 2.0, kind: 'door' },
        { at: 0.09, width: 2.0, kind: 'door' },
        { at: 0.52, width: 1.5, kind: 'window' },
        { at: 0.68, width: 1.5, kind: 'window' },
        { at: 0.15, width: 1.5, kind: 'window' },
      ],
    });
    // Two partitions with gaps, making three rooms.
    revetment(scene, [vec(84, 6), vec(83, 22)], Fabric.Concrete, 3.1, 0.7);
    revetment(scene, [vec(105, 7), vec(104, 23)], Fabric.Concrete, 3.1, 0.7);

    // --- sandbagged gun position covering the field, set clear of the house
    //     behind it: a revetment laid across a doorway seals the building.
    revetment(scene, [vec(98, 61), vec(108, 60)], Fabric.Sandbag);

    // --- wrecks on the road
    obstacle(scene, vec(48, 62), 2.4);
    obstacle(scene, vec(116, 58), 2.8);

    // --- who is where
    scene.spawns.teams = [
      [vec(40, 122), vec(41.6, 122), vec(43.2, 122), vec(44.8, 122)],
      [vec(84, 122), vec(85.6, 122), vec(87.2, 122), vec(88.8, 122)],
      [vec(128, 122), vec(129.6, 122), vec(131.2, 122), vec(132.8, 122)],
    ];
    scene.spawns.objectives = [vec(94, 14)];
    scene.spawns.enemies = [
      { pos: vec(103, 63), heavy: true },
      { pos: vec(35, 51), heavy: false },
      { pos: vec(62, 46), heavy: false },
      { pos: vec(123, 48), heavy: false },
      { pos: vec(148, 55), heavy: false },
      { pos: vec(47, 32), heavy: false },
      { pos: vec(131, 31), heavy: false },
      { pos: vec(76, 32), heavy: false },
      { pos: vec(80, 35), heavy: false },
      { pos: vec(88, 18), heavy: false },
      { pos: vec(98, 18), heavy: false },
      { pos: vec(112, 16), heavy: false },
      { pos: vec(72, 11), heavy: false },
      { pos: vec(120, 68), heavy: false },
    ];
  },
};

export const LEVELS: LevelDef[] = [STEPOVE];
