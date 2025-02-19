// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { MeshoptDecoder } from "meshoptimizer";
import * as THREE from "three";
import dracoDecoderWasmUrl from "three/examples/jsm/libs/draco/draco_decoder.wasm";
import dracoWasmWrapperJs from "three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader";

import Logger from "@foxglove/log";
import { BuiltinPanelExtensionContext } from "@foxglove/studio-base/components/PanelExtensionAdapter";

const log = Logger.getLogger(__filename);

export type MeshUpAxis = "y_up" | "z_up";
export const DEFAULT_MESH_UP_AXIS: MeshUpAxis = "y_up";

export type ModelCacheOptions = {
  edgeMaterial: THREE.Material;
  ignoreColladaUpAxis: boolean;
  meshUpAxis: MeshUpAxis;
  fetchAsset: BuiltinPanelExtensionContext["unstable_fetchAsset"];
};

type LoadModelOptions = {
  overrideMediaType?: string;
  /** A URL to e.g. a URDf which may be used to resolve mesh package:// URLs */
  referenceUrl?: string;
};

export type LoadedModel = THREE.Group | THREE.Scene;

type ErrorCallback = (err: Error) => void;

const DEFAULT_COLOR = new THREE.Color(0x248eff);

const GLTF_MIME_TYPES = ["model/gltf", "model/gltf-binary", "model/gltf+json"];
// Sourced from <https://github.com/Ultimaker/Cura/issues/4141>
const STL_MIME_TYPES = ["model/stl", "model/x.stl-ascii", "model/x.stl-binary", "application/sla"];
const DAE_MIME_TYPES = ["model/vnd.collada+xml"];
const OBJ_MIME_TYPES = ["model/obj", "text/prs.wavefront-obj"];
// 开始
export class ModelCache {
  #textDecoder = new TextDecoder();
  #models = new Map<string, Promise<LoadedModel | undefined>>();
  #edgeMaterial: THREE.Material;
  #fetchAsset: BuiltinPanelExtensionContext["unstable_fetchAsset"];

  #dracoLoader?: DRACOLoader;

  public constructor(public readonly options: ModelCacheOptions) {
    this.#edgeMaterial = options.edgeMaterial;
    this.#fetchAsset = options.fetchAsset;
  }
  /**
   * 异步加载模型
   *
   * 本函数尝试从给定的URL加载模型如果模型已缓存，则返回缓存的模型
   * 否则，将尝试加载并解析模型，同时将其添加到缓存中如果加载过程中出现错误，将调用错误回调函数报告错误
   *
   * @param url 模型的URL
   * @param opts 模型加载选项
   * @param reportError 错误回调函数，用于报告加载过程中出现的错误
   * @returns 返回一个Promise，解析为加载的模型或在出现错误时返回undefined
 */
  public async load(
    url: string,
    opts: LoadModelOptions,
    reportError: ErrorCallback,
  ): Promise<LoadedModel | undefined> {
    console.log(`ModelCache Loading model ${url}`);
    // #models 是个Map
    let promise = this.#models.get(url);
    if (promise) {
      return await promise;
    }

    promise = this.#loadModel(url, opts, reportError)
      .then((model) => addEdges(model, this.#edgeMaterial))
      .catch(async (err) => {
        reportError(err as Error);
        return undefined;
      });

    this.#models.set(url, promise);
    return await promise;
  }

  async #loadModel(
    url: string,
    options: LoadModelOptions,
    reportError: ErrorCallback,
  ): Promise<LoadedModel> {
    console.log(`loadModel---->>>>>> ${url}`);

    const GLB_MAGIC = 0x676c5446; // "glTF"

    const asset = await this.#fetchAsset(url, { referenceUrl: options.referenceUrl });

    const buffer = asset.data;
    if (buffer.byteLength < 4) {
      throw new Error(`${buffer.byteLength} bytes received`);
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const contentType = options.overrideMediaType ?? asset.mediaType ?? "";

    // Check if this is a glTF .glb or .gltf file
    // 检查这是glTF .glb还是.glTF文件
    if (
      GLB_MAGIC === view.getUint32(0, false) ||
      GLTF_MIME_TYPES.includes(contentType) ||
      /\.glb$/i.test(url) ||
      /\.gltf$/i.test(url)
    ) {
      return await this.#loadGltf(url, reportError);
    }

    // Check if this is a STL file based on content-type or file extension
    if (STL_MIME_TYPES.includes(contentType) || /\.stl$/i.test(url)) {
      // Create a copy of the array buffer to respect the `byteOffset` and `byteLength` value as
      // the underlying three.js STLLoader only accepts an ArrayBuffer instance.
      return this.#loadSTL(
        url,
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        this.options.meshUpAxis,
      );
    }

    // Check if this is a COLLADA file based on content-type or file extension
    if (DAE_MIME_TYPES.includes(contentType) || /\.dae$/i.test(url)) {
      const text = this.#textDecoder.decode(buffer);
      return await this.#loadCollada(url, text, this.options.ignoreColladaUpAxis, reportError);
    }

    // Check if this is an OBJ file based on content-type or file extension
    if (OBJ_MIME_TYPES.includes(contentType) || /\.obj$/i.test(url)) {
      const text = this.#textDecoder.decode(buffer);
      return await this.#loadOBJ(url, text, this.options.meshUpAxis, reportError);
    }

    throw new Error(`Unknown ${buffer.byteLength} byte mesh (content-type: "${contentType}")`);
  }

  async #loadGltf(url: string, reportError: ErrorCallback): Promise<LoadedModel> {
    console.log(`ModelCache Loading gltf ${url}`);

    const onError = (assetUrl: string) => {
      const originalUrl = unrewriteUrl(assetUrl);
      log.error(`Failed to load GLTF asset "${originalUrl}" for "${url}"`);
      reportError(new Error(`Failed to load GLTF asset "${originalUrl}"`));
    };

    const manager = new THREE.LoadingManager(undefined, undefined, onError);
    manager.setURLModifier(rewriteUrl);
    // 关键代码
    const gltfLoader = new GLTFLoader(manager);
    gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    // draco 是一个由谷歌开源的3D数据压缩库
    // Draco库旨在大幅加速3D数据的编码、传输和解码过程
    gltfLoader.setDRACOLoader(this.#getDracoLoader(manager));

    manager.itemStart(url);
    // 关键代码 读取gltf 模型文件
    const gltf = await gltfLoader.loadAsync(url);
    manager.itemEnd(url);

    // THREE.js uses Y-up, while Studio follows the ROS
    // [REP-0103](https://www.ros.org/reps/rep-0103.html) convention of Z-up
    gltf.scene.rotateX(Math.PI / 2);

    return gltf.scene;
  }

  #loadSTL(url: string, buffer: ArrayBuffer, meshUpAxis: MeshUpAxis): LoadedModel {
    // STL files do not reference any external assets, no LoadingManager needed
    console.log(`ModelCache Loading stl ${url}`);

    const stlLoader = new STLLoader();
    const bufferGeometry = stlLoader.parse(buffer);
    log.debug(`Finished loading STL from ${url}`);
    const material = new THREE.MeshStandardMaterial({
      name: url.slice(-32), // truncate to 32 characters
      color: DEFAULT_COLOR,
      metalness: 0,
      roughness: 1,
      dithering: true,
    });
    const mesh = new THREE.Mesh(bufferGeometry, material);
    const group = new THREE.Group();
    group.add(mesh);

    // THREE.js uses Y-up, while Studio follows the ROS
    // [REP-0103](https://www.ros.org/reps/rep-0103.html) convention of Z-up
    if (meshUpAxis === "y_up") {
      group.rotateX(Math.PI / 2);
    }

    return group;
  }

  async #loadCollada(
    url: string,
    text: string,
    // eslint-disable-next-line @foxglove/no-boolean-parameters
    ignoreUpAxis: boolean,
    reportError: ErrorCallback,
  ): Promise<LoadedModel> {
    console.log(`ModelCache Loading collada ${url}`);

    const onError = (assetUrl: string) => {
      const originalUrl = unrewriteUrl(assetUrl);
      log.error(`Failed to load COLLADA asset "${originalUrl}" for "${url}"`);
      reportError(new Error(`Failed to load COLLADA asset "${originalUrl}"`));
    };

    // The three.js ColladaLoader handles <up_axis> by detecting Z_UP and simply
    // applying a scene rotation. Since Studio is already Z_UP, we do our own
    // <up_axis> handling and skip rotation entirely for the Z_UP case
    const xml = new DOMParser().parseFromString(text, "application/xml");
    const upAxis = ignoreUpAxis
      ? "Z_UP"
      : (xml.querySelector("up_axis")?.textContent ?? "Y_UP").trim().toUpperCase();
    xml.querySelectorAll("up_axis").forEach((node) => {
      node.remove();
    });
    const xmlText = xml.documentElement.outerHTML;

    // Preload textures. We do this here since we can't pass in an async function in LoadingManager.setURLModifier
    // which is supposed to be used for overriding loading behavior. See also
    // https://threejs.org/docs/index.html#api/en/loaders/managers/LoadingManager.setURLModifier
    const textureUrls = new Map<string, string>();
    for await (const node of xml.querySelectorAll("init_from")) {
      if (!node.textContent) {
        continue;
      }

      try {
        const textureUrl = new URL(node.textContent, baseUrl(url)).toString();
        const textureAsset = await this.#fetchAsset(textureUrl);
        const objectUrl = URL.createObjectURL(
          new Blob([textureAsset.data], { type: textureAsset.mediaType }),
        );
        textureUrls.set(textureUrl, objectUrl);
      } catch (e) {
        log.error(e);
        onError(node.textContent);
      }
    }

    const manager = new THREE.LoadingManager(undefined, undefined, onError);
    manager.setURLModifier((u) => textureUrls.get(u) ?? rewriteUrl(u));
    const daeLoader = new ColladaLoader(manager);

    manager.itemStart(url);
    const dae = daeLoader.parse(xmlText, baseUrl(url));
    manager.itemEnd(url);

    for (const objectUrl of textureUrls.values()) {
      URL.revokeObjectURL(objectUrl);
    }

    // If the <up_axis> is Y_UP, rotate to the Studio convention of Z-up following
    // ROS [REP-0103](https://www.ros.org/reps/rep-0103.html)
    if (upAxis === "Y_UP") {
      dae.scene.rotateX(Math.PI / 2);
    }

    return fixDaeMaterials(dae.scene);
  }

  async #loadOBJ(
    url: string,
    text: string,
    meshUpAxis: MeshUpAxis,
    reportError: ErrorCallback,
  ): Promise<LoadedModel> {
    const onError = (assetUrl: string) => {
      const originalUrl = unrewriteUrl(assetUrl);
      log.error(`Failed to load OBJ asset "${originalUrl}" for "${url}"`);
      reportError(new Error(`Failed to load OBJ asset "${originalUrl}"`));
    };

    const manager = new THREE.LoadingManager(undefined, undefined, onError);
    manager.setURLModifier(rewriteUrl);
    const objLoader = new OBJLoader(manager);

    manager.itemStart(url);
    const group = objLoader.parse(text);
    manager.itemEnd(url);

    // THREE.js uses Y-up, while Studio follows the ROS
    // [REP-0103](https://www.ros.org/reps/rep-0103.html) convention of Z-up
    if (meshUpAxis === "y_up") {
      group.rotateX(Math.PI / 2);
    }

    return fixObjMaterials(group);
  }

  // singleton dracoloader
  #getDracoLoader(manager: THREE.LoadingManager): DRACOLoader {
    let dracoLoader = this.#dracoLoader;
    if (!dracoLoader) {
      dracoLoader = new DRACOLoader(manager);
      // Hack in a replacement function to load assets from the webpack bundle
      (dracoLoader as { _loadLibrary?: (url: string, responseType: string) => unknown })[
        "_loadLibrary"
      ] = async function (url: string, responseType: string) {
        console.log(`ModelCache Loading draco ${url}`);

        if (url === "draco_wasm_wrapper.js" && responseType === "text") {
          return dracoWasmWrapperJs;
        } else if (url === "draco_decoder.wasm" && responseType === "arraybuffer") {
          return await (await fetch(dracoDecoderWasmUrl)).arrayBuffer();
        } else {
          throw new Error(
            `DRACOLoader attempt to load non-bundled asset: ${url} as ${responseType}`,
          );
        }
      };
      this.#dracoLoader = dracoLoader;
    }

    dracoLoader.manager = manager;
    return dracoLoader;
  }

  public dispose(): void {
    // DRACOLoader is only loader that needs to be disposed because it uses a webworker
    this.#dracoLoader?.dispose();
    this.#dracoLoader = undefined;
  }
} // ModelCache END

export const EDGE_LINE_SEGMENTS_NAME = "edges";
function addEdges(model: LoadedModel, edgeMaterial: THREE.Material): LoadedModel {
  const edgesToAdd: [edges: THREE.LineSegments, parent: THREE.Object3D][] = [];

  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    // Enable shadows for all meshes
    child.castShadow = true;
    child.receiveShadow = true;

    // Draw edges for all meshes
    const edgesGeometry = new THREE.EdgesGeometry(child.geometry, 40);
    const line = new THREE.LineSegments(edgesGeometry, edgeMaterial);
    line.name = EDGE_LINE_SEGMENTS_NAME;
    edgesToAdd.push([line, child]);
  });

  for (const [line, parent] of edgesToAdd) {
    parent.add(line);
  }
  return model;
}

function fixDaeMaterials(model: LoadedModel): LoadedModel {
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    if (child.material instanceof THREE.MeshLambertMaterial) {
      const material = toStandard(child.material);
      child.material.dispose();
      child.material = material;
    } else if (child.material instanceof THREE.MeshStandardMaterial) {
      child.material.dithering = true;
    }
  });
  return model;
}

function fixObjMaterials(model: LoadedModel): LoadedModel {
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    if (child.material instanceof THREE.MeshPhongMaterial) {
      const material = toStandard(child.material);
      child.material.dispose();
      child.material = material;
    } else if (child.material instanceof THREE.MeshStandardMaterial) {
      child.material.metalness = 0;
      child.material.roughness = 1;
      child.material.dithering = true;
    }
  });
  return model;
}

function toStandard(
  material: THREE.MeshPhongMaterial | THREE.MeshLambertMaterial,
): THREE.MeshStandardMaterial {
  const standard = new THREE.MeshStandardMaterial({ name: material.name });
  const shininess = (material as Partial<THREE.MeshPhongMaterial>).shininess ?? 0; // [0-100]

  // MeshStandardMaterial.copy() assumes the normalScale property exists, which
  // is true for other MeshStandardMaterials or MeshPhongMaterial but not
  // MeshLambertMaterial. Default initialize this property if needed so the
  // `standard.copy(material)` below succeeds
  const maybePhong = material as Partial<THREE.MeshPhongMaterial>;
  maybePhong.normalScale ??= new THREE.Vector2(1, 1);

  standard.copy(material);
  standard.metalness = 0;
  standard.roughness = 1 - shininess / 100;
  standard.dithering = true;
  return standard;
}

// The THREE.TextureLoader does not support loading .tiff files into textures. To work around
// this we rewrite any `package://` url pointing at a .tiff file into a url which returns a png.
// The x-foxglove-converted-tiff protocol is used because the electron protocol handler for
// package:// uses registerFileProtocol and for converted tiff we need registerBufferProtocol
function rewriteUrl(url: string): string {
  if (url.startsWith("package://") && /\.tiff?$/i.test(url)) {
    return url.replace("package://", "x-foxglove-converted-tiff://");
  }
  return url;
}

function unrewriteUrl(url: string): string {
  if (url.startsWith("x-foxglove-converted-tiff://")) {
    return url.replace("x-foxglove-converted-tiff://", "package://");
  }
  return url;
}

function baseUrl(url: string): string {
  return url.slice(0, url.lastIndexOf("/") + 1);
}
