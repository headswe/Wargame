import * as THREE from 'three';
import type { Sim } from '../sim/sim.ts';

/** Colour unexplored geometry fades toward. */
const FOG_COLOUR = 'vec3(0.03, 0.035, 0.045)';

/** Darkness for tiles nobody can see but someone has walked past. */
const EXPLORED = 0.52;
/** Darkness for tiles nobody has ever seen. */
const UNSEEN = 0.93;

/**
 * Fog of war as a single textured quad over the map.
 *
 * Values are eased toward their target rather than snapped, so the fog breathes
 * as operators turn instead of strobing — which matters when vision is only
 * recomputed at 10 Hz.
 */
export class FogOfWar {
  private readonly data: Uint8Array;
  private readonly fade: Float32Array;
  private readonly texture: THREE.DataTexture;
  private readonly width: number;
  private readonly height: number;

  constructor(sim: Sim) {
    this.width = sim.fogCols;
    this.height = sim.fogRows;

    this.data = new Uint8Array(this.width * this.height);
    this.fade = new Float32Array(this.width * this.height).fill(UNSEEN);
    this.data.fill(Math.round(UNSEEN * 255));

    this.texture = new THREE.DataTexture(
      this.data, this.width, this.height, THREE.RedFormat, THREE.UnsignedByteType,
    );
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;

    this.worldSize = new THREE.Vector2(sim.scene.width, sim.scene.height);
  }

  private readonly worldSize: THREE.Vector2;

  /**
   * Darken a material by the fog at its own world position.
   *
   * A flat fog quad on the ground looks right until you notice walls standing
   * at full brightness inside the blackness — you can read the entire compound
   * layout through unexplored fog. Shading the geometry itself is the only
   * version that actually hides anything.
   */
  applyTo(material: THREE.Material): void {
    const texture = this.texture;
    const worldSize = this.worldSize;

    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      // Compose rather than replace: the ground already injects its own
      // material lookup, and clobbering it silently loses the terrain colours.
      previous?.call(material, shader, renderer);
      shader.uniforms.fogMap = { value: texture };
      shader.uniforms.fogWorldSize = { value: worldSize };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFogWorld;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
           vec4 fogWorldPos = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             fogWorldPos = instanceMatrix * fogWorldPos;
           #endif
           vFogWorld = (modelMatrix * fogWorldPos).xyz;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vFogWorld;\nuniform sampler2D fogMap;\nuniform vec2 fogWorldSize;',
        )
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
           vec2 fogUv = vec2(vFogWorld.x / fogWorldSize.x, vFogWorld.z / fogWorldSize.y);
           float fogShade = texture2D(fogMap, fogUv).r;
           gl_FragColor.rgb = mix(gl_FragColor.rgb, ${FOG_COLOUR}, fogShade);`,
        );
    };
    material.needsUpdate = true;
  }

  /** Darkness at a fog-grid position, for deciding what else to draw. */
  shadeAt(i: number, j: number): number {
    const tx = Math.floor(i);
    const ty = Math.floor(j);
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 1;
    return this.fade[ty * this.width + tx];
  }

  update(sim: Sim, dt: number): void {
    const k = 1 - Math.exp(-dt * 7);
    let dirty = false;

    for (let i = 0; i < this.fade.length; i++) {
      const target = sim.visibleTiles[i] === 1 ? 0 : sim.exploredTiles[i] === 1 ? EXPLORED : UNSEEN;
      const current = this.fade[i];
      if (Math.abs(target - current) < 0.002) {
        if (current !== target) {
          this.fade[i] = target;
          this.data[i] = Math.round(target * 255);
          dirty = true;
        }
        continue;
      }
      const next = current + (target - current) * k;
      this.fade[i] = next;
      this.data[i] = Math.round(next * 255);
      dirty = true;
    }

    if (dirty) this.texture.needsUpdate = true;
  }
}
