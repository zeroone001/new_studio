// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import EventEmitter from "eventemitter3";
import { quat, vec3 } from "gl-matrix";
import i18next from "i18next";
import { produce } from "immer";
import * as THREE from "three";
import { DeepPartial, assert } from "ts-essentials";
import { v4 as uuidv4 } from "uuid";

import { ObjectPool } from "@foxglove/den/collection";
import Logger from "@foxglove/log";
import { Time, fromNanoSec, isLessThan, toNanoSec } from "@foxglove/rostime";
import type { FrameTransform, FrameTransforms, SceneUpdate } from "@foxglove/schemas";
import {
  Immutable,
  MessageEvent,
  ParameterValue,
  SettingsIcon,
  SettingsTreeAction,
  SettingsTreeNodeActionItem,
  SettingsTreeNodes,
  Topic,
  VariableValue,
} from "@foxglove/studio";
import { PanelContextMenuItem } from "@foxglove/studio-base/components/PanelContextMenu";
import {
  Asset,
  BuiltinPanelExtensionContext,
  DraggedMessagePath,
  MessagePathDropStatus,
} from "@foxglove/studio-base/components/PanelExtensionAdapter";
import { HUDItemManager } from "@foxglove/studio-base/panels/ThreeDeeRender/HUDItemManager";
import { LayerErrors } from "@foxglove/studio-base/panels/ThreeDeeRender/LayerErrors";
import { ICameraHandler } from "@foxglove/studio-base/panels/ThreeDeeRender/renderables/ICameraHandler";
import IAnalytics from "@foxglove/studio-base/services/IAnalytics";
import { palette, fontMonospace } from "@foxglove/theme";
import { LabelMaterial, LabelPool } from "@foxglove/three-text";

import { HUDItem } from "./HUDItemManager";
import {
  IRenderer,
  InstancedLineMaterial,
  RendererConfig,
  RendererEvents,
  RendererSubscription,
  TestOptions,
} from "./IRenderer";
import { Input } from "./Input";
import { DEFAULT_MESH_UP_AXIS, ModelCache } from "./ModelCache";
import { PickedRenderable, Picker } from "./Picker";
import type { Renderable } from "./Renderable";
import { SceneExtension } from "./SceneExtension";
import { SceneExtensionConfig } from "./SceneExtensionConfig";
import { ScreenOverlay } from "./ScreenOverlay";
import { SettingsManager, SettingsTreeEntry } from "./SettingsManager";
import { SharedGeometry } from "./SharedGeometry";
import { CameraState } from "./camera";
import { DARK_OUTLINE, LIGHT_OUTLINE, stringToRgb } from "./color";
import { FRAME_TRANSFORMS_DATATYPES, FRAME_TRANSFORM_DATATYPES } from "./foxglove";
import { DetailLevel, msaaSamples } from "./lod";
import {
  normalizeFrameTransform,
  normalizeFrameTransforms,
  normalizeTFMessage,
  normalizeTransformStamped,
} from "./normalizeMessages";
import { CameraStateSettings } from "./renderables/CameraStateSettings";
import { ImageMode } from "./renderables/ImageMode/ImageMode";
import { MeasurementTool } from "./renderables/MeasurementTool";
import { PublishClickTool } from "./renderables/PublishClickTool";
import { MarkerPool } from "./renderables/markers/MarkerPool";
import {
  Header,
  MarkerArray,
  Quaternion,
  TFMessage,
  TF_DATATYPES,
  TRANSFORM_STAMPED_DATATYPES,
  TransformStamped,
  Vector3,
} from "./ros";
import { SelectEntry } from "./settings";
import {
  AddTransformResult,
  CoordinateFrame,
  DEFAULT_MAX_CAPACITY_PER_FRAME,
  TransformTree,
  Transform,
} from "./transforms";
import { InterfaceMode } from "./types";

const log = Logger.getLogger(__filename);

/** “自定义层”菜单的菜单项输入和回调 */
export type CustomLayerAction = {
  action: SettingsTreeNodeActionItem;
  handler: (instanceId: string) => void;
};

// 单击时显示为选择选项的最大对象数
const MAX_SELECTIONS = 10;

// 注意：这些不使用.convertSRGBToLinear（），因为背景颜色不是
// 受伽玛校正影响
const LIGHT_BACKDROP = new THREE.Color(palette.light.background?.default);
const DARK_BACKDROP = new THREE.Color(palette.dark.background?.default);

// 定义用于选择效果的多路径渲染的渲染层
const LAYER_DEFAULT = 0;
const LAYER_SELECTED = 1;

const FOLLOW_TF_PATH = ["general", "followTf"];
const NO_FRAME_SELECTED = "NO_FRAME_SELECTED";
const TF_OVERFLOW = "TF_OVERFLOW";
const CYCLE_DETECTED = "CYCLE_DETECTED";
const FOLLOW_FRAME_NOT_FOUND = "FOLLOW_FRAME_NOT_FOUND";
const ADD_TRANSFORM_ERROR = "ADD_TRANSFORM_ERROR";

// 用于创建顶级设置节点（如“主题”和
//“自定义图层”
const RENDERER_ID = "foxglove.Renderer";
/**
 * 此处声明的临时变量以避免不必要的分配和高频操作中的后续垃圾收集
 */
const tempColor = new THREE.Color();
const tempVec2 = new THREE.Vector2();
// for transforms
const tempVec3: vec3 = [0, 0, 0];
const tempQuat: quat = [0, 0, 0, 1];

// 我们使用THRE.js的修补版本，其中的内部WebGLShaderCache类
// 修改为允许基于`vertex ShaderKey`和/或`fragmentShaderKey'进行缓存，而不是
// 使用完整的着色器源作为贴图关键点
Object.defineProperty(LabelMaterial.prototype, "vertexShaderKey", {
  get() {
    return "LabelMaterial-VertexShader";
  },
  enumerable: true,
  configurable: true,
});
Object.defineProperty(LabelMaterial.prototype, "fragmentShaderKey", {
  get() {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    return this.picking ? "LabelMaterial-FragmentShader-picking" : "LabelMaterial-FragmentShader";
  },
  enumerable: true,
  configurable: true,
});

/**
 * 附加到“HTMLCanvasElement”的可扩展3D渲染器，
 * `WebGLRenderingContext`, and `SettingsTree`.
 */
export class Renderer extends EventEmitter<RendererEvents> implements IRenderer {
  public readonly interfaceMode: InterfaceMode;
  #canvas: HTMLCanvasElement;
  public readonly gl: THREE.WebGLRenderer;
  public maxLod = DetailLevel.High;

  public debugPicking: boolean;
  public config: Immutable<RendererConfig>;
  public settings: SettingsManager;
  // [{ name, datatype }]
  public topics: ReadonlyArray<Topic> | undefined;
  // topicName -> { name, datatype }
  public topicsByName: ReadonlyMap<string, Topic> | undefined;
  // parameterKey -> parameterValue
  public parameters: ReadonlyMap<string, ParameterValue> | undefined;
  // variableName -> variableValue
  public variables: ReadonlyMap<string, VariableValue> = new Map();
  // extensionId -> SceneExtension
  public sceneExtensions = new Map<string, SceneExtension>();
  // datatype -> RendererSubscription[]
  public schemaSubscriptions = new Map<string, RendererSubscription[]>();
  // topicName -> RendererSubscription[]
  public topicSubscriptions = new Map<string, RendererSubscription[]>();

  /** HUD管理器实例 */
  public hud;
  /** Items to display in the HUD */
  public hudItems: HUDItem[] = [];
  // layerId -> { action, handler }
  #customLayerActions = new Map<string, CustomLayerAction>();
  #scene: THREE.Scene;
  #dirLight: THREE.DirectionalLight;
  #hemiLight: THREE.HemisphereLight;
  public input: Input;
  public readonly outlineMaterial = new THREE.LineBasicMaterial({ dithering: true });
  public readonly instancedOutlineMaterial = new InstancedLineMaterial({ dithering: true });

  /** 仅公开用于测试-更喜欢使用“getCameraState” */
  public cameraHandler: ICameraHandler;

  #imageModeExtension?: ImageMode;

  public measurementTool: MeasurementTool;
  public publishClickTool: PublishClickTool;

  // 我们是否连接到ROS数据源？规格化坐标系（如果是）
  // 去掉任何前导的“/”前缀。有关详细信息，请参见“normalizeFrameId（）”。
  public ros = false;

  #picker: Picker;
  #selectionBackdropScene: THREE.Scene;
  #selectionBackdrop: ScreenOverlay;
  #selectedRenderable: PickedRenderable | undefined;
  public colorScheme: "dark" | "light" = "light";
  public modelCache: ModelCache;

  /**
   * 最大容量应至少选择为
   * CoordinateFrame变换的最大容量。这样它就可以储存
   * 几个坐标系被清空。
   * 最重要的是不要让这种情况无限发展。
   */
  #transformPool = new ObjectPool(Transform.Empty, {
    maxCapacity: 5 * DEFAULT_MAX_CAPACITY_PER_FRAME,
  });
  public transformTree = new TransformTree(this.#transformPool);

  public coordinateFrameList: SelectEntry[] = [];
  public currentTime = 0n;
  public fixedFrameId: string | undefined;
  public followFrameId: string | undefined;

  public labelPool = new LabelPool({ fontFamily: fontMonospace });
  public markerPool = new MarkerPool(this);
  public sharedGeometry = new SharedGeometry();

  #prevResolution = new THREE.Vector2();
  #pickingEnabled = false;
  #rendering = false;
  #animationFrame?: number;
  #cameraSyncError: undefined | string;
  #devicePixelRatioMediaQuery?: MediaQueryList;
  #fetchAsset: BuiltinPanelExtensionContext["unstable_fetchAsset"];

  public readonly displayTemporaryError?: (str: string) => void;
  /** 已通过本地测试和故事书的选项。 */
  public readonly testOptions: TestOptions;
  public analytics?: IAnalytics;
  // 构造器
  public constructor(args: {
    canvas: HTMLCanvasElement;
    config: Immutable<RendererConfig>;
    interfaceMode: InterfaceMode;
    sceneExtensionConfig: SceneExtensionConfig;
    fetchAsset: BuiltinPanelExtensionContext["unstable_fetchAsset"];
    displayTemporaryError?: (message: string) => void;
    testOptions: TestOptions;
  }) {
    super();
    // 感觉没用到
    this.displayTemporaryError = args.displayTemporaryError;
    // NOTE: Global 副作用
    THREE.Object3D.DEFAULT_UP = new THREE.Vector3(0, 0, 1);
    // 字符串 3D 或者 image
    const interfaceMode = (this.interfaceMode = args.interfaceMode);
    // DOM结构
    const canvas = (this.#canvas = args.canvas);
    // 这里面放的东西比较多
    const config = (this.config = args.config);
    console.log("Render--config", config);
    // 用于获取资源
    this.#fetchAsset = args.fetchAsset;
    this.testOptions = args.testOptions;
    this.debugPicking = args.testOptions.debugPicking ?? false;
    // 下面就是一些额外逻辑
    // 初始化hud
    this.hud = new HUDItemManager(this.#onHUDItemsChange);
    // 初始化设置管理器
    this.settings = new SettingsManager(baseSettingsTree(this.interfaceMode));
    this.settings.on("update", () => this.emit("settingsTreeChange", this));
    // 首先添加顶级节点，以便按照正确的顺序进行合并。
    //另一种方法是修改SettingsManager以允许合并父级
    //节点在其子节点之后
    this.settings.setNodesForKey(RENDERER_ID, []);
    console.log("config.layers", config.layers);
    // 使用自定义图层的数量更新“自定义图层”节点标签;不重要
    this.updateCustomLayersCount();
    // 创建渲染器，这里往下才是关键
    this.gl = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    if (!this.gl.capabilities.isWebGL2) {
      throw new Error("WebGL2 is not supported");
    }
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.autoClear = false;
    this.gl.info.autoReset = false;
    this.gl.shadowMap.enabled = false;
    this.gl.shadowMap.type = THREE.VSMShadowMap;
    this.gl.sortObjects = true;
    this.gl.setPixelRatio(window.devicePixelRatio);

    let width = canvas.width;
    let height = canvas.height;
    if (canvas.parentElement) {
      width = canvas.parentElement.clientWidth;
      height = canvas.parentElement.clientHeight;
      // setSize
      this.gl.setSize(width, height);
    }
    // 加载模型的 没整明白在哪用了
    this.modelCache = new ModelCache({
      ignoreColladaUpAxis: config.scene.ignoreColladaUpAxis ?? false,
      meshUpAxis: config.scene.meshUpAxis ?? DEFAULT_MESH_UP_AXIS,
      edgeMaterial: this.outlineMaterial,
      fetchAsset: this.#fetchAsset,
    });
    // scene 场景
    this.#scene = new THREE.Scene();
    // 从上方照射的白色平行光，强度为 Math.PI
    this.#dirLight = new THREE.DirectionalLight(0xffffff, Math.PI);
    this.#dirLight.position.set(1, 1, 1);
    this.#dirLight.castShadow = true;
    this.#dirLight.layers.enableAll();
    // 用于计算该平行光产生的阴影
    this.#dirLight.shadow.mapSize.width = 2048;
    this.#dirLight.shadow.mapSize.height = 2048;
    this.#dirLight.shadow.camera.near = 0.5;
    this.#dirLight.shadow.camera.far = 500;
    this.#dirLight.shadow.bias = -0.00001;
    // 半球光 光源直接放置于场景之上，光照颜色从天空光线颜色渐变到地面光线颜色
    this.#hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.5 * Math.PI);
    this.#hemiLight.layers.enableAll();

    this.#scene.add(this.#dirLight);
    this.#scene.add(this.#hemiLight);
    // 添加各种 鼠标和手势的事件
    this.input = new Input(canvas, () => this.cameraHandler.getActiveCamera());
    this.input.on("resize", (size) => {
      this.#resizeHandler(size);
    });
    // 添加点击事件
    this.input.on("click", (cursorCoords) => {
      // 触发左侧的面板配置
      this.#clickHandler(cursorCoords);
    });
    // 整了个 new THREE.WebGLRenderTarget
    this.#picker = new Picker(this.gl, this.#scene);
    // 着色器
    this.#selectionBackdrop = new ScreenOverlay(this);
    this.#selectionBackdropScene = new THREE.Scene();
    this.#selectionBackdropScene.add(this.#selectionBackdrop);

    const samples = msaaSamples(this.gl.capabilities);
    const renderSize = this.gl.getDrawingBufferSize(tempVec2);
    console.log(`Initialized ${renderSize.width}x${renderSize.height} renderer (${samples}x MSAA)`);

    const { reserved } = args.sceneExtensionConfig;

    this.measurementTool = reserved.measurementTool.init(this);
    this.publishClickTool = reserved.publishClickTool.init(this);
    this.#addSceneExtension(this.measurementTool);
    this.#addSceneExtension(this.publishClickTool);

    const aspect = renderSize.width / renderSize.height;
    switch (interfaceMode) {
      case "image": {
        const imageMode = reserved.imageMode.init(this);
        this.#imageModeExtension = imageMode;
        this.cameraHandler = this.#imageModeExtension;
        this.#imageModeExtension.addEventListener("hasModifiedViewChanged", () => {
          this.emit("resetViewChanged", this);
        });
        this.#addSceneExtension(this.#imageModeExtension);
        break;
      }
      case "3d": {
        // 相机 都单独搞个类，真是666
        // class CameraStateSettings extends SceneExtension
        this.cameraHandler = new CameraStateSettings(this, this.#canvas, aspect);
        this.#addSceneExtension(this.cameraHandler);
        break;
      }
    }

    const { extensionsById } = args.sceneExtensionConfig;
    console.log("extensionsById", extensionsById);

    for (const extensionItem of Object.values(extensionsById)) {
      if (
        extensionItem.supportedInterfaceModes == undefined ||
        extensionItem.supportedInterfaceModes.includes(interfaceMode)
      ) {
        this.#addSceneExtension(extensionItem.init(this));
      }
    }

    console.log(`this.sceneExtensions ${Array.from(this.sceneExtensions.keys()).join(", ")}`);

    if (interfaceMode === "image" && config.imageMode.calibrationTopic == undefined) {
      this.enableImageOnlySubscriptionMode();
    } else {
      this.#addTransformSubscriptions();
      // 添加订阅 addTopicSubscription
      this.#addSubscriptionsFromSceneExtensions();
    }
    //
    this.#watchDevicePixelRatio();

    console.log("设置相机状态111", config.cameraState);
    // 设置相机状态
    this.setCameraState(config.cameraState);
    // 开始创建场景
    this.animationFrame();
  }

  #onHUDItemsChange = () => {
    this.hudItems = this.hud.getHUDItems();
    this.emit("hudItemsChanged", this);
  };

  #onDevicePixelRatioChange = () => {
    console.log(`devicePixelRatio changed to ${window.devicePixelRatio}`);
    this.#resizeHandler(this.input.canvasSize);
    this.#watchDevicePixelRatio();
  };

  #watchDevicePixelRatio() {
    this.#devicePixelRatioMediaQuery = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    );
    this.#devicePixelRatioMediaQuery.addEventListener("change", this.#onDevicePixelRatioChange, {
      once: true,
    });
  }
  // 处理掉
  public dispose(): void {
    log.warn(`Disposing renderer`);
    this.#devicePixelRatioMediaQuery?.removeEventListener("change", this.#onDevicePixelRatioChange);
    this.removeAllListeners();

    this.settings.removeAllListeners();
    this.input.removeAllListeners();

    for (const extension of this.sceneExtensions.values()) {
      extension.dispose();
    }
    this.sceneExtensions.clear();
    this.sharedGeometry.dispose();
    this.modelCache.dispose();

    this.labelPool.dispose();
    this.markerPool.dispose();
    this.#transformPool.clear();
    this.#picker.dispose();
    this.input.dispose();
    this.gl.dispose();
  }

  public cameraSyncError(): undefined | string {
    return this.#cameraSyncError;
  }

  public setCameraSyncError(error: undefined | string): void {
    this.#cameraSyncError = error;
    // 更新相机状态设置的设置树，以考虑配置中的任何更改
    this.cameraHandler.updateSettingsTree();
  }

  public getPixelRatio(): number {
    return this.gl.getPixelRatio();
  }

  /**
   *
   * @param currentTime what renderer.currentTime will be set to
   */
  public setCurrentTime(newTimeNs: bigint): void {
    this.currentTime = newTimeNs;
  }
  /**
   * 根据查找增量更新渲染器状态。如果向后看，则处理未来状态的清除和所有帧光标的重置
   *应在调用“setCurrentTime”之后调用
   * @param oldTime used to determine if seeked backwards
   */
  public handleSeek(oldTimeNs: bigint): void {
    const movedBack = this.currentTime < oldTimeNs;
    // 如果我们向后搜索，希望清除转换并重置光标
    this.clear({ clearTransforms: movedBack, resetAllFramesCursor: movedBack });
  }

  /**
   * 清除：
   *-渲染对象（执行回填以确保使用当前帧中的新消息重新生成这些对象）
   *-设置错误。过去导致错误的消息会被清除，但如果在读入时仍导致错误，则会重新添加。
   *-[可选]转换树。当执行对先前时间的搜索以将潜在的未来状态刷新到新设置的时间时，这应该设置为真。
   *-[可选]allFramesCursor。这是在截至currentTime的所有帧中迭代的光标。向后搜索时应重置它，以避免保持未来状态。
   * @param {Object} params - modifiers to the clear operation
   * @param {boolean} params.clearTransforms - whether to clear the transform tree. This should be set to true when a seek to a previous time is performed in order
   * order to flush potential future state to the newly set time.
   * @param {boolean} params.resetAllFramesCursor - whether to reset the cursor for the allFrames array.
   * Order to clear ImageMode renderables or not. Defaults to true. Not relevant in 3D panel.
   * @param {boolean} params.clearImageModeExtension - whether to reset ImageMode renderables in clear.
   */
  public clear(
    {
      clearTransforms,
      resetAllFramesCursor,
      clearImageModeExtension = true,
    }: {
      clearTransforms?: boolean;
      resetAllFramesCursor?: boolean;
      clearImageModeExtension?: boolean;
    } = {
      clearTransforms: false,
      resetAllFramesCursor: false,
    },
  ): void {
    this.#clearSubscriptionQueues();
    if (clearTransforms === true) {
      this.#clearTransformTree();
    }
    if (resetAllFramesCursor === true) {
      this.#resetAllFramesCursor();
    }
    this.settings.errors.clear();
    this.hud.clear();

    for (const extension of this.sceneExtensions.values()) {
      if (!clearImageModeExtension && extension === this.#imageModeExtension) {
        continue;
      }
      extension.removeAllRenderables();
    }
    this.queueAnimationFrame();
  }

  #allFramesCursor: {
    // index represents where the last read message is in allFrames
    index: number;
    lastReadMessage: MessageEvent | undefined;
    cursorTimeReached?: Time;
  } = {
    index: -1,
    lastReadMessage: undefined,
    cursorTimeReached: undefined,
  };

  #clearSubscriptionQueues(): void {
    for (const subscriptions of this.topicSubscriptions.values()) {
      for (const subscription of subscriptions) {
        subscription.queue = undefined;
      }
    }
    for (const subscriptions of this.schemaSubscriptions.values()) {
      for (const subscription of subscriptions) {
        subscription.queue = undefined;
      }
    }
  }

  #resetAllFramesCursor() {
    this.#allFramesCursor = {
      index: -1,
      lastReadMessage: undefined,
      cursorTimeReached: undefined,
    };
    this.emit("resetAllFramesCursor", this);
  }

  /**
   * 遍历所有帧并使用receiveTime处理消息<=currentTime
   * @param allFrames - sorted array of all preloaded messages
   * @returns {boolean} - whether the allFramesCursor has been updated and new messages were read in
   */
  public handleAllFramesMessages(allFrames?: readonly MessageEvent[]): boolean {
    if (!allFrames || allFrames.length === 0) {
      return false;
    }

    const currentTime = fromNanoSec(this.currentTime);

    /**
     *关于allFramesCursor所需的allFrames的假设：
     *-始终按receiveTime排序
     *-allFrame块只从开始到结束加载，没有任何逐出
     */
    const messageAtCursor = allFrames[this.#allFramesCursor.index];

    // 如果lastReadMessage不再与光标处的消息相同，则重置光标
    //这意味着消息已从阵列中添加或删除，需要重新读取
    if (
      this.#allFramesCursor.lastReadMessage != undefined &&
      messageAtCursor != undefined &&
      this.#allFramesCursor.lastReadMessage !== messageAtCursor
    ) {
      this.#resetAllFramesCursor();
    }

    let cursor = this.#allFramesCursor.index;
    let cursorTimeReached = this.#allFramesCursor.cursorTimeReached;
    let lastReadMessage = this.#allFramesCursor.lastReadMessage;

    // 光标永远不应该超过allFramesLength，如果它是这样的话，这意味着光标在逐出之前位于“allFrames”的末尾，并且逐出缩短了allFrames
    //在这种情况下，我们应该将光标设置为allFrames的末尾
    cursor = Math.min(cursor, allFrames.length - 1);

    let message;

    let hasAddedMessageEvents = false;
    // load preloaded messages up to current time
    while (cursor < allFrames.length - 1) {
      cursor++;
      message = allFrames[cursor]!;
      // read messages until we reach the current time
      if (isLessThan(currentTime, message.receiveTime)) {
        cursorTimeReached = currentTime;
        // reset cursor to last read message index
        cursor--;
        break;
      }
      if (!hasAddedMessageEvents) {
        hasAddedMessageEvents = true;
      }

      this.addMessageEvent(message);
      lastReadMessage = message;
      if (cursor === allFrames.length - 1) {
        cursorTimeReached = message.receiveTime;
      }
    }

    // 加载到当前时间的预加载消息
    if (!hasAddedMessageEvents) {
      return false;
    }

    this.#allFramesCursor = { index: cursor, cursorTimeReached, lastReadMessage };
    return true;
  }
  // 场景扩展
  #addSceneExtension(extension: SceneExtension): void {
    if (this.sceneExtensions.has(extension.extensionId)) {
      throw new Error(`Attempted to add duplicate extensionId "${extension.extensionId}"`);
    }
    // Map 格式存储
    this.sceneExtensions.set(extension.extensionId, extension);
    this.#scene.add(extension);
  }
  // 更新config
  public updateConfig(updateHandler: (draft: RendererConfig) => void): void {
    this.config = produce(this.config, updateHandler);
    this.emit("configChange", this);
  }
  // 添加转换订阅
  #addTransformSubscriptions(): void {
    const config = this.config;
    const preloadTransforms = config.scene.transforms?.enablePreloading ?? true;
    // 用于更新转换树的TF消息的内部处理程序
    this.#addSchemaSubscriptions(FRAME_TRANSFORM_DATATYPES, {
      handler: this.#handleFrameTransform,
      shouldSubscribe: () => true,
      preload: preloadTransforms,
    });
    this.#addSchemaSubscriptions(FRAME_TRANSFORMS_DATATYPES, {
      handler: this.#handleFrameTransforms,
      shouldSubscribe: () => true,
      preload: preloadTransforms,
    });
    this.#addSchemaSubscriptions(TF_DATATYPES, {
      handler: this.#handleTFMessage,
      shouldSubscribe: () => true,
      preload: preloadTransforms,
    });
    this.#addSchemaSubscriptions(TRANSFORM_STAMPED_DATATYPES, {
      handler: this.#handleTransformStamped,
      shouldSubscribe: () => true,
      preload: preloadTransforms,
    });
    this.off("resetAllFramesCursor", this.#clearTransformTree);
    if (preloadTransforms) {
      this.on("resetAllFramesCursor", this.#clearTransformTree);
    }
  }
  // 清除
  #clearTransformTree = () => {
    this.transformTree.clear();
  };

  // 调用场景扩展以向渲染器添加订阅
  #addSubscriptionsFromSceneExtensions(filterFn?: (extension: SceneExtension) => boolean): void {
    const filteredExtensions = filterFn
      ? Array.from(this.sceneExtensions.values()).filter(filterFn)
      : this.sceneExtensions.values();
    console.log("filteredExtensions", filteredExtensions);

    for (const extension of filteredExtensions) {
      const subscriptions = extension.getSubscriptions();
      for (const subscription of subscriptions) {
        switch (subscription.type) {
          case "schema":
            this.#addSchemaSubscriptions(
              subscription.schemaNames,
              subscription.subscription as RendererSubscription,
            );
            break;
          case "topic":
            this.#addTopicSubscription(
              subscription.topicName,
              subscription.subscription as RendererSubscription,
            );
            break;
        }
      }
    }
  }

  // 清除主题和架构订阅，并发出两者的更改事件
  #clearSubscriptions(): void {
    this.topicSubscriptions.clear();
    this.schemaSubscriptions.clear();
    this.emit("topicSubscriptionsChanged", this);
    this.emit("schemaSubscriptionsChanged", this);
  }

  #addSchemaSubscriptions<T>(
    schemaNames: Iterable<string>,
    subscription: RendererSubscription<T>,
  ): void {
    console.log("schemaNames", schemaNames);
    for (const schemaName of schemaNames) {
      let handlers = this.schemaSubscriptions.get(schemaName);
      if (!handlers) {
        handlers = [];
        this.schemaSubscriptions.set(schemaName, handlers);
      }
      handlers.push(subscription as RendererSubscription);
    }
    this.emit("schemaSubscriptionsChanged", this);
  }

  #addTopicSubscription<T>(topic: string, subscription: RendererSubscription<T>): void {
    let handlers = this.topicSubscriptions.get(topic);
    if (!handlers) {
      handlers = [];
      this.topicSubscriptions.set(topic, handlers);
    }
    handlers.push(subscription as RendererSubscription);
    this.emit("topicSubscriptionsChanged", this);
  }

  /**
   * “仅图像”模式禁用非ImageMode场景扩展的所有订阅，并清除所有变换订阅。
   *只有在未选择校准主题的情况下，才应在ImageMode中启用此模式。禁用这些订阅
   *防止由于相机信息不足而渲染场景的3D方面。
   */
  public enableImageOnlySubscriptionMode = (): void => {
    assert(
      this.#imageModeExtension,
      "Image mode extension should be defined when calling enable Image only mode",
    );
    this.clear({
      clearTransforms: true,
      resetAllFramesCursor: true,
      clearImageModeExtension: false,
    });
    this.#clearSubscriptions();
    this.#addSubscriptionsFromSceneExtensions(
      (extension) => extension === this.#imageModeExtension,
    );
    this.settings.addNodeValidator(this.#imageOnlyModeTopicSettingsValidator);
  };

  public disableImageOnlySubscriptionMode = (): void => {
    // .clear() will clean up remaining errors on topics
    this.settings.removeNodeValidator(this.#imageOnlyModeTopicSettingsValidator);
    this.clear({
      clearTransforms: true,
      resetAllFramesCursor: true,
      clearImageModeExtension: false,
    });
    this.#clearSubscriptions();
    this.#addSubscriptionsFromSceneExtensions();
    this.#addTransformSubscriptions();
  };

  /** 未定义校准时，将错误添加到可见的主题节点 */
  #imageOnlyModeTopicSettingsValidator = (entry: SettingsTreeEntry, errors: LayerErrors) => {
    const { path, node } = entry;
    if (path[0] === "topics") {
      if (node.visible === true) {
        errors.addToTopic(
          path[1]!,
          "IMAGE_ONLY_TOPIC",
          "Camera calibration information is required to display 3D topics",
        );
      } else {
        errors.removeFromTopic(path[1]!, "IMAGE_ONLY_TOPIC");
      }
    }
  };

  public addCustomLayerAction(options: {
    layerId: string;
    label: string;
    icon?: SettingsIcon;
    handler: (instanceId: string) => void;
  }): void {
    const handler = options.handler;
    // A unique id is assigned to each action to deduplicate selection events
    // The layerId is used to map selection events back to their handlers
    const instanceId = uuidv4();
    const action: SettingsTreeNodeActionItem = {
      type: "action",
      id: `${options.layerId}-${instanceId}`,
      label: options.label,
      icon: options.icon,
    };
    this.#customLayerActions.set(options.layerId, { action, handler });
    this.#updateTopicsAndCustomLayerSettingsNodes();
  }

  #updateTopicsAndCustomLayerSettingsNodes(): void {
    this.settings.setNodesForKey(RENDERER_ID, [
      this.#getTopicsSettingsEntry(),
      this.#getCustomLayersSettingsEntry(),
    ]);
  }

  #getTopicsSettingsEntry(): SettingsTreeEntry {
    // "Topics" settings tree node
    const topics: SettingsTreeEntry = {
      path: ["topics"],
      node: {
        enableVisibilityFilter: true,
        label: i18next.t("threeDee:topics"),
        defaultExpansionState: "expanded",
        actions: [
          { id: "show-all", type: "action", label: i18next.t("threeDee:showAll") },
          { id: "hide-all", type: "action", label: i18next.t("threeDee:hideAll") },
        ],
        children: this.settings.tree()["topics"]?.children,
        handler: this.#handleTopicsAction,
      },
    };
    return topics;
  }

  #getCustomLayersSettingsEntry(): SettingsTreeEntry {
    const layerCount = Object.keys(this.config.layers).length;
    const customLayers: SettingsTreeEntry = {
      path: ["layers"],
      node: {
        label: `${i18next.t("threeDee:customLayers")}${layerCount > 0 ? ` (${layerCount})` : ""}`,
        children: this.settings.tree()["layers"]?.children,
        actions: Array.from(this.#customLayerActions.values()).map((entry) => entry.action),
        handler: this.#handleCustomLayersAction,
      },
    };
    return customLayers;
  }

  /** Enable or disable object selection mode */
  // eslint-disable-next-line @foxglove/no-boolean-parameters
  public setPickingEnabled(enabled: boolean): void {
    this.#pickingEnabled = enabled;
    if (!enabled) {
      this.setSelectedRenderable(undefined);
    }
  }

  /** 更新配色方案和背景色，根据需要重建任何材质 */
  public setColorScheme(colorScheme: "dark" | "light", backgroundColor: string | undefined): void {
    this.colorScheme = colorScheme;

    const bgColor = backgroundColor
      ? stringToRgb(tempColor, backgroundColor).convertSRGBToLinear()
      : undefined;

    for (const extension of this.sceneExtensions.values()) {
      extension.setColorScheme(colorScheme, bgColor);
    }

    if (colorScheme === "dark") {
      this.gl.setClearColor(bgColor ?? DARK_BACKDROP);
      this.outlineMaterial.color.set(DARK_OUTLINE);
      this.outlineMaterial.needsUpdate = true;
      this.instancedOutlineMaterial.color.set(DARK_OUTLINE);
      this.instancedOutlineMaterial.needsUpdate = true;
      this.#selectionBackdrop.setColor(DARK_BACKDROP, 0.8);
    } else {
      this.gl.setClearColor(bgColor ?? LIGHT_BACKDROP);
      this.outlineMaterial.color.set(LIGHT_OUTLINE);
      this.outlineMaterial.needsUpdate = true;
      this.instancedOutlineMaterial.color.set(LIGHT_OUTLINE);
      this.instancedOutlineMaterial.needsUpdate = true;
      this.#selectionBackdrop.setColor(LIGHT_BACKDROP, 0.8);
    }
  }

  /** 当主题列表的标识更改时，更新主题列表并重新生成所有设置节点*/
  public setTopics(topics: ReadonlyArray<Topic> | undefined): void {
    if (this.topics === topics) {
      return;
    }
    this.topics = topics;

    // Rebuild topicsByName
    this.topicsByName = topics ? new Map(topics.map((topic) => [topic.name, topic])) : undefined;

    this.emit("topicsChanged", this);

    // Rebuild the settings nodes for all scene extensions
    for (const extension of this.sceneExtensions.values()) {
      this.settings.setNodesForKey(extension.extensionId, extension.settingsNodes());
    }
  }

  public setParameters(parameters: ReadonlyMap<string, ParameterValue> | undefined): void {
    const changed = this.parameters !== parameters;
    this.parameters = parameters;
    if (changed) {
      this.emit("parametersChange", parameters, this);
    }
  }
  // 使用自定义图层的数量更新“自定义图层”节点标签
  public updateCustomLayersCount(): void {
    const layerCount = Object.keys(this.config.layers).length;
    const label = `Custom Layers${layerCount > 0 ? ` (${layerCount})` : ""}`;
    this.settings.setLabel(["layers"], label);
  }

  public setCameraState(cameraState: CameraState): void {
    this.cameraHandler.setCameraState(cameraState);
  }

  public getCameraState(): CameraState | undefined {
    return this.cameraHandler.getCameraState();
  }

  public canResetView(): boolean {
    return this.#imageModeExtension?.hasModifiedView() ?? false;
  }

  public resetView(): void {
    this.#imageModeExtension?.resetViewModifications();
    this.queueAnimationFrame();
  }
  // 选择，
  public setSelectedRenderable(selection: PickedRenderable | undefined): void {
    if (this.#selectedRenderable === selection) {
      return;
    }

    const prevSelected = this.#selectedRenderable;
    if (prevSelected) {
      // Deselect the previously selected renderable
      deselectObject(prevSelected.renderable);
      console.log(`Deselected ${prevSelected.renderable.id} (${prevSelected.renderable.name})`);
    }

    this.#selectedRenderable = selection;

    if (selection) {
      // Select the newly selected renderable
      selectObject(selection.renderable);
      console.log(
        `Selected ${selection.renderable.id} (${selection.renderable.name}) (instance=${selection.instanceIndex})`,
        selection.renderable,
      );
    }

    this.emit("selectedRenderable", selection, this);

    if (!this.debugPicking) {
      this.animationFrame();
    }
  }

  public addMessageEvent(messageEvent: Readonly<MessageEvent>): void {
    const { message } = messageEvent;

    const maybeHasHeader = message as DeepPartial<{ header: Header }>;
    const maybeHasMarkers = message as DeepPartial<MarkerArray>;
    const maybeHasEntities = message as DeepPartial<SceneUpdate>;
    const maybeHasFrameId = message as DeepPartial<Header>;

    // Extract coordinate frame IDs from all incoming messages
    if (maybeHasHeader.header) {
      // If this message has a Header, scrape the frame_id from it
      const frameId = maybeHasHeader.header.frame_id ?? "";
      this.addCoordinateFrame(frameId);
    } else if (Array.isArray(maybeHasMarkers.markers)) {
      // If this message has an array called markers, scrape frame_id from all markers
      for (const marker of maybeHasMarkers.markers) {
        if (marker) {
          const frameId = marker.header?.frame_id ?? "";
          this.addCoordinateFrame(frameId);
        }
      }
    } else if (Array.isArray(maybeHasEntities.entities)) {
      // If this message has an array called entities, scrape frame_id from all entities
      for (const entity of maybeHasEntities.entities) {
        if (entity) {
          const frameId = entity.frame_id ?? "";
          this.addCoordinateFrame(frameId);
        }
      }
    } else if (typeof maybeHasFrameId.frame_id === "string") {
      // If this message has a top-level frame_id, scrape it
      this.addCoordinateFrame(maybeHasFrameId.frame_id);
    }

    queueMessage(messageEvent, this.topicSubscriptions.get(messageEvent.topic));
    queueMessage(messageEvent, this.schemaSubscriptions.get(messageEvent.schemaName));
  }

  /** 通过从中剥离前导斜杠来匹配“tf：：Transformer”的行为
    *frame_ids。这保留了与早期版本的ROS的兼容性，同时
    *不破坏任何当前版本，其中：
    *>tf2不接受以“/”开头的frame_ids
    来源http://wiki.ros.org/tf2/Migration#tf_prefix_backwards_compatibility
   */
  public normalizeFrameId(frameId: string): string {
    if (!this.ros || !frameId.startsWith("/")) {
      return frameId;
    }
    return frameId.slice(1);
  }

  public addCoordinateFrame(frameId: string): void {
    const normalizedFrameId = this.normalizeFrameId(frameId);
    if (!this.transformTree.hasFrame(normalizedFrameId)) {
      this.transformTree.getOrCreateFrame(normalizedFrameId);
      this.coordinateFrameList = this.transformTree.frameList();
      // console.log(`Added coordinate frame "${normalizedFrameId}"`);
      this.emit("transformTreeUpdated", this);
    }
  }

  #addFrameTransform(transform: FrameTransform): void {
    const parentId = transform.parent_frame_id;
    const childId = transform.child_frame_id;
    try {
      const stamp = toNanoSec(transform.timestamp);
      const t = transform.translation;
      const q = transform.rotation;

      this.addTransform(parentId, childId, stamp, t, q);
    } catch (err) {
      this.settings.errors.add(
        ["transforms"],
        ADD_TRANSFORM_ERROR,
        `Error adding transform for frame ${childId}: ${err.message}`,
      );
    }
  }

  #addTransformMessage(tf: TransformStamped): void {
    const normalizedParentId = this.normalizeFrameId(tf.header.frame_id);
    const normalizedChildId = this.normalizeFrameId(tf.child_frame_id);
    try {
      const stamp = toNanoSec(tf.header.stamp);
      const t = tf.transform.translation;
      const q = tf.transform.rotation;

      this.addTransform(normalizedParentId, normalizedChildId, stamp, t, q);
    } catch (err) {
      this.settings.errors.add(
        ["transforms"],
        ADD_TRANSFORM_ERROR,
        `Error adding transform for frame ${normalizedChildId}: ${err.message}`,
      );
    }
  }

  // 创建新变换并将其添加到渲染器的TransformTree
  public addTransform(
    parentFrameId: string,
    childFrameId: string,
    stamp: bigint,
    translation: Vector3,
    rotation: Quaternion,
    errorSettingsPath?: string[],
  ): void {
    const t = translation;
    const q = rotation;

    tempVec3[0] = t.x;
    tempVec3[1] = t.y;
    tempVec3[2] = t.z;

    tempQuat[0] = q.x;
    tempQuat[1] = q.y;
    tempQuat[2] = q.z;
    tempQuat[3] = q.w;

    const transform = this.#transformPool.acquire();
    transform.setPositionRotation(tempVec3, tempQuat);
    const status = this.transformTree.addTransform(childFrameId, parentFrameId, stamp, transform);

    if (status === AddTransformResult.UPDATED) {
      this.coordinateFrameList = this.transformTree.frameList();
      this.emit("transformTreeUpdated", this);
    }

    if (status === AddTransformResult.CYCLE_DETECTED) {
      this.settings.errors.add(
        ["transforms", `frame:${childFrameId}`],
        CYCLE_DETECTED,
        `Transform tree cycle detected: Received transform with parent "${parentFrameId}" and child "${childFrameId}", but "${childFrameId}" is already an ancestor of "${parentFrameId}". Transform message dropped.`,
      );
      if (errorSettingsPath) {
        this.settings.errors.add(
          errorSettingsPath,
          CYCLE_DETECTED,
          `Attempted to add cyclical transform: Frame "${parentFrameId}" cannot be the parent of frame "${childFrameId}". Transform message dropped.`,
        );
      }
    }

    // Check if the transform history for this frame is at capacity and show an error if so. This
    // error can't be cleared until the scene is reloaded
    const frame = this.transformTree.getOrCreateFrame(childFrameId);
    if (frame.transformsSize() === frame.maxCapacity) {
      this.settings.errors.add(
        ["transforms", `frame:${childFrameId}`],
        TF_OVERFLOW,
        `[Warning] Transform history is at capacity (${frame.maxCapacity}), old TFs will be dropped`,
      );
    }
  }

  public removeTransform(childFrameId: string, parentFrameId: string, stamp: bigint): void {
    this.transformTree.removeTransform(childFrameId, parentFrameId, stamp);
    this.coordinateFrameList = this.transformTree.frameList();
    this.emit("transformTreeUpdated", this);
  }

  // Callback handlers
  public animationFrame = (): void => {
    this.#animationFrame = undefined;
    if (!this.#rendering) {
      this.#frameHandler(this.currentTime);
      this.#rendering = false;
    }
  };
  // 利用 requestAnimationFrame 开始，这也是渲染步骤的开始
  public queueAnimationFrame(): void {
    console.log("queueAnimationFrame");

    if (this.#animationFrame == undefined) {
      this.#animationFrame = requestAnimationFrame(this.animationFrame);
    }
  }

  public setFollowFrameId(frameId: string | undefined): void {
    if (this.followFrameId !== frameId) {
      console.log(`Setting followFrameId to ${frameId}`);
    }
    this.followFrameId = frameId;
  }

  public async fetchAsset(
    uri: string,
    options?: { signal?: AbortSignal; baseUrl?: string },
  ): Promise<Asset> {
    return await this.#fetchAsset(uri, options);
  }
  // 在这个函数里面执行render的渲染步骤， requestAnimationFrame的回调函数
  #frameHandler = (currentTime: bigint): void => {
    console.log("frameHandler");

    // rendering设置成 true，表示正在渲染
    this.#rendering = true;
    this.currentTime = currentTime;
    this.#handleSubscriptionQueues();
    this.#updateFrameErrors();
    this.#updateFixedFrameId();
    this.#updateResolution();

    this.gl.clear();
    this.emit("startFrame", currentTime, this);

    const camera = this.cameraHandler.getActiveCamera();
    camera.layers.set(LAYER_DEFAULT);

    // 如果renderFrame未定义且没有变换选项，请使用FALLBACK_FRAME_ID
    const renderFrameId =
      this.followFrameId && this.transformTree.frame(this.followFrameId)
        ? this.followFrameId
        : CoordinateFrame.FALLBACK_FRAME_ID;
    const fixedFrameId = this.fixedFrameId ?? CoordinateFrame.FALLBACK_FRAME_ID;

    for (const sceneExtension of this.sceneExtensions.values()) {
      sceneExtension.startFrame(currentTime, renderFrameId, fixedFrameId);
    }
    // 最终的渲染场景，这一行才是关键
    this.gl.render(this.#scene, camera);

    if (this.#selectedRenderable) {
      this.gl.render(this.#selectionBackdropScene, camera);
      this.gl.clearDepth();
      camera.layers.set(LAYER_SELECTED);
      this.gl.render(this.#scene, camera);
    }

    this.emit("endFrame", currentTime, this);

    this.gl.info.reset();
  };

  /** 遍历所有订阅消息队列，对其进行处理，并为帧中的每条消息调用其处理程序 */
  #handleSubscriptionQueues(): void {
    for (const subscriptions of this.topicSubscriptions.values()) {
      for (const subscription of subscriptions) {
        if (!subscription.queue) {
          continue;
        }
        const { queue, filterQueue } = subscription;
        const processedQueue = filterQueue ? filterQueue(queue) : queue;
        subscription.queue = undefined;
        for (const messageEvent of processedQueue) {
          subscription.handler(messageEvent);
        }
      }
    }
    for (const subscriptions of this.schemaSubscriptions.values()) {
      for (const subscription of subscriptions) {
        if (!subscription.queue) {
          continue;
        }
        const { queue, filterQueue } = subscription;
        const processedQueue = filterQueue ? filterQueue(queue) : queue;
        subscription.queue = undefined;
        for (const messageEvent of processedQueue) {
          subscription.handler(messageEvent);
        }
      }
    }
  }

  #updateFixedFrameId(): void {
    const frame =
      this.followFrameId != undefined ? this.transformTree.frame(this.followFrameId) : undefined;

    if (frame == undefined) {
      this.fixedFrameId = undefined;
      return;
    }
    const fixedFrame = frame.root();
    const fixedFrameId = fixedFrame.id;
    if (this.fixedFrameId !== fixedFrameId) {
      if (this.fixedFrameId == undefined) {
        console.log(`Setting fixed frame to ${fixedFrameId}`);
      } else {
        console.log(`Changing fixed frame from "${this.fixedFrameId}" to "${fixedFrameId}"`);
      }
      this.fixedFrameId = fixedFrameId;
    }
  }

  #resizeHandler = (size: THREE.Vector2): void => {
    this.gl.setPixelRatio(window.devicePixelRatio);
    this.gl.setSize(size.width, size.height);
    this.cameraHandler.handleResize(size.width, size.height, window.devicePixelRatio);

    const renderSize = this.gl.getDrawingBufferSize(tempVec2);
    console.log(`Resized renderer to ${renderSize.width}x${renderSize.height}`);
    this.animationFrame();
  };
  // 3D 的 点击事件
  #clickHandler = (cursorCoords: THREE.Vector2): void => {
    console.log("clickHandler");

    if (!this.#pickingEnabled) {
      this.setSelectedRenderable(undefined);
      return;
    }

    //工具处于活动状态时禁用拾取
    if (this.measurementTool.state !== "idle" || this.publishClickTool.state !== "idle") {
      return;
    }

    // 取消选择当前选定的对象（如果已选定），然后重新渲染
    //更新渲染列表的场景
    this.setSelectedRenderable(undefined);

    // 拾取单个可渲染对象，隐藏它，重新渲染，然后再次运行拾取，直到
    //背景被击中或我们超过了MAX_SELECTIONS
    const camera = this.cameraHandler.getActiveCamera();
    const selections: PickedRenderable[] = [];
    let curSelection: PickedRenderable | undefined;
    while (
      (curSelection = this.#pickSingleObject(cursorCoords)) &&
      selections.length < MAX_SELECTIONS
    ) {
      selections.push(curSelection);
      // 如果debugPicking处于启用状态，我们不希望通过进行更多迭代来覆盖hitmap
      if (this.debugPicking) {
        break;
      }
      curSelection.renderable.visible = false;
      this.gl.render(this.#scene, camera);
    }

    // 将所有内容恢复正常并渲染最后一帧
    for (const selection of selections) {
      selection.renderable.visible = true;
    }
    if (!this.debugPicking) {
      this.animationFrame();
    }

    console.log(`Clicked ${selections.length} renderable(s)`);
    this.emit("renderablesClicked", selections, cursorCoords, this);
  };

  #handleFrameTransform = ({ message }: MessageEvent<DeepPartial<FrameTransform>>): void => {
    // foxglove.FrameTransform - Ingest this single transform into our TF tree
    const transform = normalizeFrameTransform(message);
    this.#addFrameTransform(transform);
  };

  #handleFrameTransforms = ({ message }: MessageEvent<DeepPartial<FrameTransforms>>): void => {
    // foxglove.FrameTransforms - Ingest the list of transforms into our TF tree
    const frameTransforms = normalizeFrameTransforms(message);
    for (const transform of frameTransforms.transforms) {
      this.#addFrameTransform(transform);
    }
  };

  #handleTFMessage = ({ message }: MessageEvent<DeepPartial<TFMessage>>): void => {
    // tf2_msgs/TFMessage - Ingest the list of transforms into our TF tree
    const tfMessage = normalizeTFMessage(message);
    for (const tf of tfMessage.transforms) {
      this.#addTransformMessage(tf);
    }
  };

  #handleTransformStamped = ({ message }: MessageEvent<DeepPartial<TransformStamped>>): void => {
    // geometry_msgs/TransformStamped - Ingest this single transform into our TF tree
    const tf = normalizeTransformStamped(message);
    this.#addTransformMessage(tf);
  };

  #handleTopicsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "perform-node-action" || path.length !== 1 || path[0] !== "topics") {
      return;
    }
    console.log(`handleTopicsAction(${action.payload.id})`);

    // eslint-disable-next-line @foxglove/no-boolean-parameters
    const toggleTopicVisibility = (value: boolean) => {
      for (const extension of this.sceneExtensions.values()) {
        for (const node of extension.settingsNodes()) {
          if (node.path[0] === "topics") {
            extension.handleSettingsAction({
              action: "update",
              payload: { path: [...node.path, "visible"], input: "boolean", value },
            });
          }
        }
      }
    };

    if (action.payload.id === "show-all") {
      // Show all topics
      toggleTopicVisibility(true);
    } else if (action.payload.id === "hide-all") {
      // Hide all topics
      toggleTopicVisibility(false);
    }
  };

  #handleCustomLayersAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "perform-node-action" || path.length !== 1 || path[0] !== "layers") {
      return;
    }
    console.log(`handleCustomLayersAction(${action.payload.id})`);

    // Remove `-{uuid}` from the actionId to get the layerId
    const actionId = action.payload.id;
    const layerId = actionId.slice(0, -37);
    const instanceId = actionId.slice(-36);

    const entry = this.#customLayerActions.get(layerId);
    if (!entry) {
      throw new Error(`No custom layer action found for "${layerId}"`);
    }

    // Regenerate the action menu entry with a new instanceId. The unique instanceId is generated
    // here so we can deduplicate multiple callbacks for the same menu click event
    const { label, icon } = entry.action;
    this.addCustomLayerAction({ layerId, label, icon, handler: entry.handler });

    // Trigger the add custom layer action handler
    entry.handler(instanceId);

    // Update the Custom Layers node label with the number of custom layers
    this.updateCustomLayersCount();
  };

  #pickSingleObject(cursorCoords: THREE.Vector2): PickedRenderable | undefined {
    // Render a single pixel using a fragment shader that writes object IDs as
    // colors, then read the value of that single pixel back
    const objectId = this.#picker.pick(
      cursorCoords.x,
      cursorCoords.y,
      this.cameraHandler.getActiveCamera(),
      { debug: this.debugPicking, disableSetViewOffset: this.interfaceMode === "image" },
    );
    if (objectId === -1) {
      console.log("Picking did not return an object");
      return undefined;
    }

    // Traverse the scene looking for this objectId
    const pickedObject = this.#scene.getObjectById(objectId);

    // Find the highest ancestor of the picked object that is a Renderable
    let renderable: Renderable | undefined;
    let maybeRenderable = pickedObject as Partial<Renderable> | undefined;
    while (maybeRenderable) {
      if (maybeRenderable.pickable === true) {
        renderable = maybeRenderable as Renderable;
      }
      maybeRenderable = (maybeRenderable.parent ?? undefined) as Partial<Renderable> | undefined;
    }

    if (!renderable) {
      log.warn(
        `No Renderable found for objectId ${objectId} (name="${pickedObject?.name}" uuid=${pickedObject?.uuid})`,
      );
      return undefined;
    }

    console.log(`Picking pass returned ${renderable.id} (${renderable.name})`, renderable);

    let instanceIndex: number | undefined;
    if (renderable.pickableInstances) {
      instanceIndex = this.#picker.pickInstance(
        cursorCoords.x,
        cursorCoords.y,
        this.cameraHandler.getActiveCamera(),
        renderable,
        { debug: this.debugPicking, disableSetViewOffset: this.interfaceMode === "image" },
      );
      instanceIndex = instanceIndex === -1 ? undefined : instanceIndex;
      console.log("Instance picking pass on", renderable, "returned", instanceIndex);
    }

    return { renderable, instanceIndex };
  }

  #updateFrameErrors(): void {
    if (this.followFrameId == undefined) {
      // No frames available
      this.settings.errors.add(
        FOLLOW_TF_PATH,
        NO_FRAME_SELECTED,
        i18next.t("threeDee:noCoordinateFramesFound"),
      );
      return;
    }

    this.settings.errors.remove(FOLLOW_TF_PATH, NO_FRAME_SELECTED);

    const frame = this.transformTree.frame(this.followFrameId);

    // The follow frame id should be chosen from a frameId that exists, but
    // we still need to watch out for the case that the transform tree was
    // cleared before that could be updated
    if (!frame) {
      this.settings.errors.add(
        FOLLOW_TF_PATH,
        FOLLOW_FRAME_NOT_FOUND,
        i18next.t("threeDee:frameNotFound", {
          frameId: this.followFrameId,
        }),
      );
      return;
    }

    this.settings.errors.remove(FOLLOW_TF_PATH, FOLLOW_FRAME_NOT_FOUND);
  }
  public getContextMenuItems = (): PanelContextMenuItem[] => {
    return Array.from(this.sceneExtensions.values()).flatMap((extension) =>
      extension.getContextMenuItems(),
    );
  };

  #updateResolution(): void {
    const resolution = this.input.canvasSize;
    if (this.#prevResolution.equals(resolution)) {
      return;
    }
    this.#prevResolution.copy(resolution);

    this.#scene.traverse((object) => {
      if ((object as Partial<THREE.Mesh>).material) {
        const mesh = object as THREE.Mesh;
        const material = mesh.material as Partial<THREE.ShaderMaterial>;

        // Update render resolution uniforms
        if (material.uniforms?.resolution) {
          material.uniforms.resolution.value.copy(resolution);
          material.uniformsNeedUpdate = true;
        }
      }
    });
  }

  public getDropStatus = (paths: readonly DraggedMessagePath[]): MessagePathDropStatus => {
    const effects: ("add" | "replace")[] = [];
    for (const path of paths) {
      let effect;
      for (const extension of this.sceneExtensions.values()) {
        const maybeEffect = extension.getDropEffectForPath(path);
        if (maybeEffect) {
          effect = maybeEffect;
          break;
        }
      }
      // if a single path does not have a drop effect, all paths are not droppable
      if (effect == undefined) {
        return { canDrop: false };
      }
      effects.push(effect);
    }
    // prioritize replace effect over add
    const finalEffect = effects.includes("replace") ? "replace" : "add";

    return {
      canDrop: true,
      effect: finalEffect,
    };
  };

  public handleDrop = (paths: readonly DraggedMessagePath[]): void => {
    this.updateConfig((draft) => {
      for (const path of paths) {
        for (const extension of this.sceneExtensions.values()) {
          extension.updateConfigForDropPath(draft, path);
        }
      }
    });
  };

  public setAnalytics(analytics: IAnalytics): void {
    this.analytics = analytics;
  }
} // Renderer END

function queueMessage(
  messageEvent: Readonly<MessageEvent>,
  subscriptions: RendererSubscription[] | undefined,
): void {
  if (subscriptions) {
    for (const subscription of subscriptions) {
      subscription.queue = subscription.queue ?? [];
      subscription.queue.push(messageEvent);
    }
  }
}

function selectObject(object: THREE.Object3D) {
  object.layers.set(LAYER_SELECTED);
  object.traverse((child) => {
    child.layers.set(LAYER_SELECTED);
  });
}

function deselectObject(object: THREE.Object3D) {
  object.layers.set(LAYER_DEFAULT);
  object.traverse((child) => {
    child.layers.set(LAYER_DEFAULT);
  });
}

/**
 * 创建骨架设置树。树内容由场景扩展填充
 * 这规定了组在设置编辑器中显示的顺序
 */
function baseSettingsTree(interfaceMode: InterfaceMode): SettingsTreeNodes {
  const keys: string[] = [];
  keys.push(interfaceMode === "image" ? "imageMode" : "general", "scene");
  if (interfaceMode === "image") {
    keys.push("imageAnnotations");
  }
  if (interfaceMode === "3d") {
    keys.push("cameraState");
  }
  keys.push("transforms", "topics", "layers");
  if (interfaceMode === "3d") {
    keys.push("publish");
  }
  return Object.fromEntries(keys.map((key) => [key, {}]));
}
