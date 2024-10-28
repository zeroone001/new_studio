// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";
import { useSnackbar } from "notistack";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useLatest } from "react-use";
import { DeepPartial } from "ts-essentials";
import { useDebouncedCallback } from "use-debounce";

import Logger from "@foxglove/log";
import { Time, toNanoSec } from "@foxglove/rostime";
import {
  Immutable,
  LayoutActions,
  MessageEvent,
  ParameterValue,
  RenderState,
  SettingsTreeAction,
  SettingsTreeNodes,
  Subscription,
  Topic,
} from "@foxglove/studio";
import { AppSetting } from "@foxglove/studio-base/AppSetting";
import { BuiltinPanelExtensionContext } from "@foxglove/studio-base/components/PanelExtensionAdapter";
import { useAnalytics } from "@foxglove/studio-base/context/AnalyticsContext";
import {
  DEFAULT_SCENE_EXTENSION_CONFIG,
  SceneExtensionConfig,
} from "@foxglove/studio-base/panels/ThreeDeeRender/SceneExtensionConfig";
import ThemeProvider from "@foxglove/studio-base/theme/ThemeProvider";

import type {
  FollowMode,
  IRenderer,
  ImageModeConfig,
  RendererConfig,
  RendererSubscription,
  TestOptions,
} from "./IRenderer";
import type { PickedRenderable } from "./Picker";
import { SELECTED_ID_VARIABLE } from "./Renderable";
import { Renderer } from "./Renderer";
import { RendererContext, useRendererEvent, useRendererProperty } from "./RendererContext";
import { RendererOverlay } from "./RendererOverlay";
import { CameraState, DEFAULT_CAMERA_STATE } from "./camera";
import {
  PublishRos1Datatypes,
  PublishRos2Datatypes,
  makePointMessage,
  makePoseEstimateMessage,
  makePoseMessage,
} from "./publish";
import type { LayerSettingsTransform } from "./renderables/FrameAxes";
import { PublishClickEventMap } from "./renderables/PublishClickTool";
import { DEFAULT_PUBLISH_SETTINGS } from "./renderables/PublishSettings";
import { InterfaceMode } from "./types";

const log = Logger.getLogger(__filename);

type Shared3DPanelState = {
  cameraState: CameraState;
  followMode: FollowMode;
  followTf: undefined | string;
};
// 样式
const PANEL_STYLE: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  position: "relative",
};

/**
 * 渲染三维场景的面板。这是一个围绕“Renderer”实例的薄包装。
 */
export function ThreeDeeRender(props: {
  context: BuiltinPanelExtensionContext;
  interfaceMode: InterfaceMode;
  testOptions: TestOptions;
  /** 允许通过自定义扩展插入或覆盖默认扩展 */
  customSceneExtensions?: DeepPartial<SceneExtensionConfig>;
}): JSX.Element {
  console.log("ThreeDeeRender function");

  const { context, interfaceMode, testOptions, customSceneExtensions } = props;
  const {
    initialState,
    saveState,
    unstable_fetchAsset: fetchAsset,
    unstable_setMessagePathDropConfig: setMessagePathDropConfig,
  } = context;
  // 分析
  const analytics = useAnalytics();

  // 加载并保存持久化的面板配置
  // useState 的惰性初始化
  // 可以传递一个函数作为 useState 的参数，
  // 这个函数会在组件的首次渲染时被调用，而不是在每次渲染时都被调用
  // 这种特性在处理大量数据或昂贵的计算时特别有用，
  // 因为它可以避免不必要的重复操作，从而提高应用的性能。
  const [config, setConfig] = useState<Immutable<RendererConfig>>(() => {
    const partialConfig = initialState as DeepPartial<RendererConfig> | undefined;

    // 从覆盖有持久设置的默认设置初始化相机
    const cameraState: CameraState = _.merge(
      _.cloneDeep(DEFAULT_CAMERA_STATE),
      partialConfig?.cameraState,
    );
    const publish = _.merge(_.cloneDeep(DEFAULT_PUBLISH_SETTINGS), partialConfig?.publish);

    const transforms = (partialConfig?.transforms ?? {}) as Record<
      string,
      Partial<LayerSettingsTransform>
    >;

    return {
      cameraState,
      followMode: partialConfig?.followMode ?? "follow-pose",
      followTf: partialConfig?.followTf,
      scene: partialConfig?.scene ?? {},
      transforms,
      topics: partialConfig?.topics ?? {},
      layers: partialConfig?.layers ?? {},
      publish,
      // config上的deep-partial，使梯度元组类型[string|undefined，string|undefin]
      // 与`Partial＜ColorModeSettings>不兼容`
      imageMode: (partialConfig?.imageMode ?? {}) as Partial<ImageModeConfig>,
    };
  });
  const configRef = useLatest(config);
  const { cameraState } = config;
  const backgroundColor = config.scene.backgroundColor;
  // 在ref中使用，相当于 setCanvas(this); ref={setCanvas}
  // 需要触发视图的不断地渲染
  const [canvas, setCanvas] = useState<HTMLCanvasElement | ReactNull>(ReactNull);
  const [renderer, setRenderer] = useState<IRenderer | undefined>(undefined);
  // 作为一个变量，用于销毁
  const rendererRef = useRef<IRenderer | undefined>(undefined);

  const { enqueueSnackbar } = useSnackbar();

  const displayTemporaryError = useCallback(
    (errorString: string) => {
      enqueueSnackbar(errorString, { variant: "error" });
    },
    [enqueueSnackbar],
  );
  // 在这里整的threejs
  useEffect(() => {
    console.log("ThreeDeeRender-useEffect--->", canvas, configRef, interfaceMode);

    const newRenderer = canvas
      ? new Renderer({
          canvas,
          config: configRef.current,
          interfaceMode,
          fetchAsset,
          sceneExtensionConfig: _.merge(
            {},
            DEFAULT_SCENE_EXTENSION_CONFIG,
            customSceneExtensions ?? {},
          ),
          displayTemporaryError,
          testOptions,
        })
      : undefined;
    setRenderer(newRenderer);
    rendererRef.current = newRenderer;
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = undefined;
    };
  }, [
    canvas,
    configRef,
    config.scene.transforms?.enablePreloading,
    customSceneExtensions,
    interfaceMode,
    fetchAsset,
    testOptions,
    displayTemporaryError,
  ]);

  useEffect(() => {
    if (renderer) {
      renderer.setAnalytics(analytics);
    }
  }, [renderer, analytics]);

  useEffect(() => {
    setMessagePathDropConfig(
      renderer
        ? {
            getDropStatus: renderer.getDropStatus,
            handleDrop: renderer.handleDrop,
          }
        : undefined,
    );
  }, [setMessagePathDropConfig, renderer]);
  // 下面是一系列useState
  const [colorScheme, setColorScheme] = useState<"dark" | "light" | undefined>();
  const [timezone, setTimezone] = useState<string | undefined>();
  const [topics, setTopics] = useState<ReadonlyArray<Topic> | undefined>();
  const [parameters, setParameters] = useState<
    Immutable<Map<string, ParameterValue>> | undefined
  >();
  const [currentFrameMessages, setCurrentFrameMessages] = useState<
    ReadonlyArray<MessageEvent> | undefined
  >();
  const [currentTime, setCurrentTime] = useState<Time | undefined>();
  const [didSeek, setDidSeek] = useState<boolean>(false);
  const [sharedPanelState, setSharedPanelState] = useState<undefined | Shared3DPanelState>();
  const [allFrames, setAllFrames] = useState<readonly MessageEvent[] | undefined>(undefined);
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  // 放个全局变量
  const renderRef = useRef({ needsRender: false });

  const schemaSubscriptions = useRendererProperty(
    "schemaSubscriptions",
    "schemaSubscriptionsChanged",
    () => new Map(),
    renderer,
  );
  const topicSubscriptions = useRendererProperty(
    "topicSubscriptions",
    "topicSubscriptionsChanged",
    () => new Map(),
    renderer,
  );

  // 配置相机状态
  useEffect(() => {
    const listener = () => {
      if (renderer) {
        const newCameraState = renderer.getCameraState();
        if (!newCameraState) {
          return;
        }
        // 这需要在“setConfig”之前，否则在低模式播放期间会出现闪烁
        renderer.setCameraState(newCameraState);
        setConfig((prevConfig) => ({ ...prevConfig, cameraState: newCameraState }));

        if (config.scene.syncCamera === true) {
          context.setSharedPanelState({
            cameraState: newCameraState,
            followMode: config.followMode,
            followTf: renderer.followFrameId,
          });
        }
      }
    };
    renderer?.addListener("cameraMove", listener);
    return () => void renderer?.removeListener("cameraMove", listener);
  }, [config.scene.syncCamera, config.followMode, context, renderer?.followFrameId, renderer]);

  // 在设置侧边栏中处理用户更改
  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      // 包装在不稳定的_batchedUpdates中会导致React在handleAction中运行effect_after_
      //函数已完成执行。这允许场景扩展调用
      //renderer.updateConfig读取新的配置值并配置其可渲染文件
      //在渲染发生之前
      ReactDOM.unstable_batchedUpdates(() => {
        if (renderer) {
          const initialCameraState = renderer.getCameraState();
          renderer.settings.handleAction(action);
          const updatedCameraState = renderer.getCameraState();
          // Communicate camera changes from settings to the global state if syncing.
          if (updatedCameraState !== initialCameraState && config.scene.syncCamera === true) {
            context.setSharedPanelState({
              cameraState: updatedCameraState,
              followMode: config.followMode,
              followTf: renderer.followFrameId,
            });
          }
        }
      });
    },
    [config.followMode, config.scene.syncCamera, context, renderer],
  );

  // 维护设置树
  const [settingsTree, setSettingsTree] = useState<SettingsTreeNodes | undefined>(undefined);
  const updateSettingsTree = useCallback((curRenderer: IRenderer) => {
    setSettingsTree(curRenderer.settings.tree());
  }, []);
  useRendererEvent("settingsTreeChange", updateSettingsTree, renderer);

  // 更改面板配置时保存该配置
  const updateConfig = useCallback((curRenderer: IRenderer) => {
    setConfig(curRenderer.config);
  }, []);
  useRendererEvent("configChange", updateConfig, renderer);

  // 当前选择更改时写入全局变量
  const updateSelectedRenderable = useCallback(
    (selection: PickedRenderable | undefined) => {
      const id = selection?.renderable.idFromMessage();
      const customVariable = selection?.renderable.selectedIdVariable();
      if (customVariable) {
        context.setVariable(customVariable, id);
      }
      context.setVariable(SELECTED_ID_VARIABLE, id);
    },
    [context],
  );
  useRendererEvent("selectedRenderable", updateSelectedRenderable, renderer);

  const [focusedSettingsPath, setFocusedSettingsPath] = useState<undefined | readonly string[]>();

  const onShowTopicSettings = useCallback((topic: string) => {
    setFocusedSettingsPath(["topics", topic]);
  }, []);

  // 根据需要重建设置侧边栏树
  useEffect(() => {
    context.updatePanelSettingsEditor({
      actionHandler,
      enableFilter: true,
      focusedPath: focusedSettingsPath,
      nodes: settingsTree ?? {},
    });
  }, [actionHandler, context, focusedSettingsPath, settingsTree]);

  // 当“配置”更改时，更新渲染器对“配置”的引用。请注意，这并不** 自动更新设置树
  useEffect(() => {
    if (renderer) {
      renderer.config = config;
      renderRef.current.needsRender = true;
    }
  }, [config, renderer]);

  // 更改时更新渲染器对“topics”的引用
  useEffect(() => {
    if (renderer) {
      renderer.setTopics(topics);
      renderRef.current.needsRender = true;
    }
  }, [topics, renderer]);

  // 告诉渲染器我们是否连接到ROS数据源
  useEffect(() => {
    if (renderer) {
      renderer.ros = context.dataSourceProfile === "ros1" || context.dataSourceProfile === "ros2";
    }
  }, [context.dataSourceProfile, renderer]);

  // 更改面板设置时保存这些设置
  const throttledSave = useDebouncedCallback(
    (newConfig: Immutable<RendererConfig>) => {
      saveState(newConfig);
    },
    1000,
    { leading: false, trailing: true, maxWait: 1000 },
  );
  useEffect(() => throttledSave(config), [config, throttledSave]);

  // 在图像模式下，使默认面板标题与所选图像主题保持最新
  useEffect(() => {
    if (interfaceMode === "image") {
      context.setDefaultPanelTitle(config.imageMode.imageTopic);
    }
  }, [interfaceMode, context, config.imageMode.imageTopic]);

  // 使用context.watch和context.onRender建立到消息管道的连接
  useLayoutEffect(() => {
    context.onRender = (renderState: Immutable<RenderState>, done) => {
      ReactDOM.unstable_batchedUpdates(() => {
        if (renderState.currentTime) {
          setCurrentTime(renderState.currentTime);
        }

        // 检查didSeek是否设置为true以重置预加载的MessageTime和
        //在渲染器中触发状态刷新
        if (renderState.didSeek === true) {
          setDidSeek(true);
        }

        // Set the done callback into a state variable to trigger a re-render
        setRenderDone(() => done);

        // Keep UI elements and the renderer aware of the current color scheme
        setColorScheme(renderState.colorScheme);
        if (renderState.appSettings) {
          const tz = renderState.appSettings.get(AppSetting.TIMEZONE);
          setTimezone(typeof tz === "string" ? tz : undefined);
        }

        // We may have new topics - since we are also watching for messages in
        // the current frame, topics may not have changed
        setTopics(renderState.topics);

        setSharedPanelState(renderState.sharedPanelState as Shared3DPanelState);

        // Watch for any changes in the map of observed parameters
        setParameters(renderState.parameters);

        // currentFrame has messages on subscribed topics since the last render call
        setCurrentFrameMessages(renderState.currentFrame);

        // allFrames在所有框架中都有关于预加载主题的消息（加载时）
        console.log("allFrames", renderState.allFrames);
        setAllFrames(renderState.allFrames);
      });
    };

    context.watch("allFrames");
    context.watch("colorScheme");
    context.watch("currentFrame");
    context.watch("currentTime");
    context.watch("didSeek");
    context.watch("parameters");
    context.watch("sharedPanelState");
    context.watch("topics");
    context.watch("appSettings");
    context.subscribeAppSettings([AppSetting.TIMEZONE]);
  }, [context, renderer]);

  // 建立要订阅的主题列表
  const [topicsToSubscribe, setTopicsToSubscribe] = useState<Subscription[] | undefined>(undefined);
  useEffect(() => {
    if (!topics) {
      setTopicsToSubscribe(undefined);
      return;
    }

    const newSubscriptions: Subscription[] = [];

    const addSubscription = (
      topic: Topic,
      rendererSubscription: RendererSubscription,
      convertTo?: string,
    ) => {
      let shouldSubscribe = rendererSubscription.shouldSubscribe?.(topic.name);
      if (shouldSubscribe == undefined) {
        if (config.topics[topic.name]?.visible === true) {
          shouldSubscribe = true;
        } else if (config.imageMode.annotations?.[topic.name]?.visible === true) {
          shouldSubscribe = true;
        } else {
          shouldSubscribe = false;
        }
      }
      if (shouldSubscribe) {
        newSubscriptions.push({
          topic: topic.name,
          preload: rendererSubscription.preload,
          convertTo,
        });
      }
    };

    for (const topic of topics) {
      for (const rendererSubscription of topicSubscriptions.get(topic.name) ?? []) {
        addSubscription(topic, rendererSubscription);
      }
      for (const rendererSubscription of schemaSubscriptions.get(topic.schemaName) ?? []) {
        addSubscription(topic, rendererSubscription);
      }
      for (const schemaName of topic.convertibleTo ?? []) {
        for (const rendererSubscription of schemaSubscriptions.get(schemaName) ?? []) {
          addSubscription(topic, rendererSubscription, schemaName);
        }
      }
    }

    // 对列表进行排序以使比较稳定
    newSubscriptions.sort((a, b) => a.topic.localeCompare(b.topic));
    setTopicsToSubscribe((prev) => (_.isEqual(prev, newSubscriptions) ? prev : newSubscriptions));
  }, [
    topics,
    config.topics,
    // Need to update subscriptions when imagemode topics change
    // shouldSubscribe values will be re-evaluated
    config.imageMode.calibrationTopic,
    config.imageMode.imageTopic,
    schemaSubscriptions,
    topicSubscriptions,
    config.imageMode.annotations,
    // Need to update subscriptions when layers change as URDF layers might subscribe to topics
    // shouldSubscribe values will be re-evaluated
    config.layers,
  ]);

  // 当我们的订阅列表更改时通知扩展上下文
  useEffect(() => {
    if (!topicsToSubscribe) {
      return;
    }
    log.debug(`Subscribing to [${topicsToSubscribe.map((t) => JSON.stringify(t)).join(", ")}]`);
    context.subscribe(topicsToSubscribe);
  }, [context, topicsToSubscribe]);

  // 使渲染器参数保持最新
  useEffect(() => {
    if (renderer) {
      renderer.setParameters(parameters);
    }
  }, [parameters, renderer]);

  // 保持渲染器的最新时间并处理搜索
  useEffect(() => {
    const newTimeNs = currentTime ? toNanoSec(currentTime) : undefined;

    /*
     * 关于查找处理的注意事项
     *即使当前时间没有变化，也必须处理查找。当有订阅时
     *暂停时更改，玩家进入“寻找回填”，将didSeek设置为true。
     *
     *当当前时间没有因此而改变时，我们不能提前返回这里，否则会
     *下次当前时间更改时处理seek，并清除回填的消息和转换。
     */
    if (!renderer || newTimeNs == undefined) {
      return;
    }
    const oldTimeNs = renderer.currentTime;

    renderer.setCurrentTime(newTimeNs);
    if (didSeek) {
      renderer.handleSeek(oldTimeNs);
      setDidSeek(false);
    }
  }, [currentTime, renderer, didSeek]);

  // 保持渲染器的配色方案和背景颜色是最新的
  useEffect(() => {
    if (colorScheme && renderer) {
      renderer.setColorScheme(colorScheme, backgroundColor);
      renderRef.current.needsRender = true;
    }
  }, [backgroundColor, colorScheme, renderer]);

  // 处理预加载的消息，如果有新消息可用，则渲染帧
  // 应在处理“消息”之前调用
  useEffect(() => {
    // 我们希望didsseek首先由渲染器处理，这样在光标出现后就不会清除转换
    if (!renderer || !currentTime) {
      return;
    }
    const newMessagesHandled = renderer.handleAllFramesMessages(allFrames);
    if (newMessagesHandled) {
      renderRef.current.needsRender = true;
    }
  }, [renderer, currentTime, allFrames]);

  // 如果有新消息可用，则处理消息并渲染帧
  useEffect(() => {
    if (!renderer || !currentFrameMessages) {
      return;
    }

    for (const message of currentFrameMessages) {
      renderer.addMessageEvent(message);
    }

    renderRef.current.needsRender = true;
  }, [currentFrameMessages, renderer]);

  // 摄影机移动时更新渲染器
  useEffect(() => {
    if (!_.isEqual(cameraState, renderer?.getCameraState())) {
      renderer?.setCameraState(cameraState);
      renderRef.current.needsRender = true;
    }
  }, [cameraState, renderer]);

  // 将相机与共享状态同步（如果启用）。
  useEffect(() => {
    if (!renderer || sharedPanelState == undefined || config.scene.syncCamera !== true) {
      return;
    }

    if (sharedPanelState.followMode !== config.followMode) {
      renderer.setCameraSyncError(
        `Follow mode must be ${sharedPanelState.followMode} to sync camera.`,
      );
    } else if (sharedPanelState.followTf !== renderer.followFrameId) {
      renderer.setCameraSyncError(
        `Display frame must be ${sharedPanelState.followTf} to sync camera.`,
      );
    } else {
      const newCameraState = sharedPanelState.cameraState;
      renderer.setCameraState(newCameraState);
      renderRef.current.needsRender = true;
      setConfig((prevConfig) => ({
        ...prevConfig,
        cameraState: newCameraState,
      }));
      renderer.setCameraSyncError(undefined);
    }
  }, [
    config.scene.syncCamera,
    config.followMode,
    renderer,
    renderer?.followFrameId,
    sharedPanelState,
  ]);

  // 如果请求，渲染新帧
  useEffect(() => {
    if (renderer && renderRef.current.needsRender) {
      renderer.animationFrame();
      renderRef.current.needsRender = false;
    }
  });

  // 渲染完成后调用done回调
  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // 创建一个useCallback包装，用于将新面板添加到布局中，用于打开
  //对象检查器的“原始消息”面板
  const addPanel = useCallback(
    (params: Parameters<LayoutActions["addPanel"]>[0]) => {
      context.layout.addPanel(params);
    },
    [context.layout],
  );

  const [measureActive, setMeasureActive] = useState(false);
  useEffect(() => {
    const onStart = () => {
      setMeasureActive(true);
    };
    const onEnd = () => {
      setMeasureActive(false);
    };
    renderer?.measurementTool.addEventListener("foxglove.measure-start", onStart);
    renderer?.measurementTool.addEventListener("foxglove.measure-end", onEnd);
    return () => {
      renderer?.measurementTool.removeEventListener("foxglove.measure-start", onStart);
      renderer?.measurementTool.removeEventListener("foxglove.measure-end", onEnd);
    };
  }, [renderer?.measurementTool]);

  const onClickMeasure = useCallback(() => {
    if (measureActive) {
      renderer?.measurementTool.stopMeasuring();
    } else {
      renderer?.measurementTool.startMeasuring();
      renderer?.publishClickTool.stop();
    }
  }, [measureActive, renderer]);

  const [publishActive, setPublishActive] = useState(false);
  useEffect(() => {
    if (renderer?.publishClickTool.publishClickType !== config.publish.type) {
      renderer?.publishClickTool.setPublishClickType(config.publish.type);
      // stop if we changed types while a publish action was already in progress
      renderer?.publishClickTool.stop();
    }
  }, [config.publish.type, renderer]);

  const publishTopics = useMemo(() => {
    return {
      goal: config.publish.poseTopic,
      point: config.publish.pointTopic,
      pose: config.publish.poseEstimateTopic,
    };
  }, [config.publish.poseTopic, config.publish.pointTopic, config.publish.poseEstimateTopic]);

  useEffect(() => {
    const datatypes =
      context.dataSourceProfile === "ros2" ? PublishRos2Datatypes : PublishRos1Datatypes;
    context.advertise?.(publishTopics.goal, "geometry_msgs/PoseStamped", { datatypes });
    context.advertise?.(publishTopics.point, "geometry_msgs/PointStamped", { datatypes });
    context.advertise?.(publishTopics.pose, "geometry_msgs/PoseWithCovarianceStamped", {
      datatypes,
    });

    return () => {
      context.unadvertise?.(publishTopics.goal);
      context.unadvertise?.(publishTopics.point);
      context.unadvertise?.(publishTopics.pose);
    };
  }, [publishTopics, context, context.dataSourceProfile]);

  const latestPublishConfig = useLatest(config.publish);

  useEffect(() => {
    const onStart = () => {
      setPublishActive(true);
    };
    const onSubmit = (event: PublishClickEventMap["foxglove.publish-submit"]) => {
      const frameId = renderer?.followFrameId;
      if (frameId == undefined) {
        log.warn("Unable to publish, renderFrameId is not set");
        return;
      }
      if (!context.publish) {
        log.error("Data source does not support publishing");
        return;
      }
      if (context.dataSourceProfile !== "ros1" && context.dataSourceProfile !== "ros2") {
        log.warn("Publishing is only supported in ros1 and ros2");
        return;
      }

      try {
        switch (event.publishClickType) {
          case "point": {
            const message = makePointMessage(event.point, frameId);
            context.publish(publishTopics.point, message);
            break;
          }
          case "pose": {
            const message = makePoseMessage(event.pose, frameId);
            context.publish(publishTopics.goal, message);
            break;
          }
          case "pose_estimate": {
            const message = makePoseEstimateMessage(
              event.pose,
              frameId,
              latestPublishConfig.current.poseEstimateXDeviation,
              latestPublishConfig.current.poseEstimateYDeviation,
              latestPublishConfig.current.poseEstimateThetaDeviation,
            );
            context.publish(publishTopics.pose, message);
            break;
          }
        }
      } catch (error) {
        log.info(error);
      }
    };
    const onEnd = () => {
      setPublishActive(false);
    };
    renderer?.publishClickTool.addEventListener("foxglove.publish-start", onStart);
    renderer?.publishClickTool.addEventListener("foxglove.publish-submit", onSubmit);
    renderer?.publishClickTool.addEventListener("foxglove.publish-end", onEnd);
    return () => {
      renderer?.publishClickTool.removeEventListener("foxglove.publish-start", onStart);
      renderer?.publishClickTool.removeEventListener("foxglove.publish-submit", onSubmit);
      renderer?.publishClickTool.removeEventListener("foxglove.publish-end", onEnd);
    };
  }, [
    context,
    latestPublishConfig,
    publishTopics,
    renderer?.followFrameId,
    renderer?.publishClickTool,
  ]);

  const onClickPublish = useCallback(() => {
    if (publishActive) {
      renderer?.publishClickTool.stop();
    } else {
      renderer?.publishClickTool.start();
      renderer?.measurementTool.stopMeasuring();
    }
  }, [publishActive, renderer]);

  const onTogglePerspective = useCallback(() => {
    const currentState = renderer?.getCameraState()?.perspective ?? false;
    actionHandler({
      action: "update",
      payload: {
        input: "boolean",
        path: ["cameraState", "perspective"],
        value: !currentState,
      },
    });
  }, [actionHandler, renderer]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "3" && !(event.metaKey || event.ctrlKey)) {
        onTogglePerspective();
        event.stopPropagation();
        event.preventDefault();
      }
    },
    [onTogglePerspective],
  );

  // 3d面板仅支持发布到ros1和ros2数据源
  const isRosDataSource =
    context.dataSourceProfile === "ros1" || context.dataSourceProfile === "ros2";
  const canPublish = context.publish != undefined && isRosDataSource;

  return (
    <ThemeProvider isDark={colorScheme === "dark"}>
      <div style={PANEL_STYLE} onKeyDown={onKeyDown}>
        {/* 真正的3D内容所在地 */}
        <canvas
          className="true3Dcontainer"
          ref={setCanvas}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            ...((measureActive || publishActive) && { cursor: "crosshair" }),
          }}
        />
        {/*  在3D场景的顶部提供DOM覆盖元素（例如统计数据、调试GUI）
          这是右上角的按钮配置之类的
        */}
        <RendererContext.Provider value={renderer}>
          <RendererOverlay
            interfaceMode={interfaceMode}
            canvas={canvas}
            addPanel={addPanel}
            enableStats={config.scene.enableStats ?? false}
            perspective={config.cameraState.perspective}
            onTogglePerspective={onTogglePerspective}
            measureActive={measureActive}
            onClickMeasure={onClickMeasure}
            canPublish={canPublish}
            publishActive={publishActive}
            onClickPublish={onClickPublish}
            onShowTopicSettings={onShowTopicSettings}
            publishClickType={renderer?.publishClickTool.publishClickType ?? "point"}
            onChangePublishClickType={(type) => {
              renderer?.publishClickTool.setPublishClickType(type);
              renderer?.publishClickTool.start();
            }}
            timezone={timezone}
          />
        </RendererContext.Provider>
      </div>
    </ThemeProvider>
  );
}
