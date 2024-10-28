// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import type { IRenderer } from "./IRenderer";

type vec4 = [number, number, number, number];

export class ScreenOverlay extends THREE.Object3D {
  #material: THREE.ShaderMaterial;

  public constructor(renderer: IRenderer) {
    super();
    // 过它，你可以使用自定义的着色器，在 WebGL 环境中直接运行。
    // 着色器可以将 Three.js 中的 JavaScript 网格转换为屏幕上的像素。
    // 通过这些自定义的着色器，你可以明确地指定对象的渲染方式
    this.#material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: { color: { value: [1, 0, 1, 1] } },
      vertexShader: /* glsl */ `
        void main() {
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec4 color;
        void main() {
          gl_FragColor = color;
        }
      `,
    });

    const geometry = renderer.sharedGeometry.getGeometry(this.constructor.name, createGeometry);
    const mesh = new THREE.Mesh(geometry, this.#material);
    mesh.frustumCulled = false;
    this.add(mesh);
  }

  public setColor(color: THREE.Color, opacity: number): void {
    const colorUniform = this.#material.uniforms.color!.value as vec4;
    colorUniform[0] = color.r;
    colorUniform[1] = color.g;
    colorUniform[2] = color.b;
    colorUniform[3] = opacity;
  }
}

function createGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(2, 2, 1, 1);
  return geometry;
}
