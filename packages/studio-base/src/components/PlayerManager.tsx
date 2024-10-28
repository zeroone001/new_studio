// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { useSnackbar } from "notistack";
import { PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useMountedState } from "react-use";

import { useWarnImmediateReRender } from "@foxglove/hooks";
// import Logger from "@foxglove/log";
import { Immutable } from "@foxglove/studio";
import { MessagePipelineProvider } from "@foxglove/studio-base/components/MessagePipeline";
import { useAnalytics } from "@foxglove/studio-base/context/AnalyticsContext";
import { useAppContext } from "@foxglove/studio-base/context/AppContext";
import { ExtensionCatalogContext } from "@foxglove/studio-base/context/ExtensionCatalogContext";
import PlayerSelectionContext, {
  DataSourceArgs,
  IDataSourceFactory,
  PlayerSelection,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import useIndexedDbRecents, { RecentRecord } from "@foxglove/studio-base/hooks/useIndexedDbRecents";
import AnalyticsMetricsCollector from "@foxglove/studio-base/players/AnalyticsMetricsCollector";
import {
  TopicAliasFunctions,
  TopicAliasingPlayer,
} from "@foxglove/studio-base/players/TopicAliasingPlayer/TopicAliasingPlayer";
import { Player } from "@foxglove/studio-base/players/types";

type PlayerManagerProps = {
  playerSources: readonly IDataSourceFactory[];
};

export default function PlayerManager(props: PropsWithChildren<PlayerManagerProps>): JSX.Element {
  console.log("PlayerManager--->");

  const { children, playerSources } = props;

  useWarnImmediateReRender();

  const { wrapPlayer } = useAppContext();

  const isMounted = useMountedState();

  const analytics = useAnalytics();
  const metricsCollector = useMemo(() => new AnalyticsMetricsCollector(analytics), [analytics]);
  // basePlayer 其实是来自Ros2LocalBagDataSourceFactory的里面的  IterablePlayer .ts
  const [basePlayer, setBasePlayer] = useState<Player | undefined>();

  const { recents, addRecent } = useIndexedDbRecents();

  const topicAliasPlayer = useMemo(() => {
    if (!basePlayer) {
      return undefined;
    }
    // 在这里初始化的,basePlayer 就是IterablePlayer
    return new TopicAliasingPlayer(basePlayer);
  }, [basePlayer]);

  // 当别名函数发生更改时更新它们。我们不需要重新任命球员经理
  //因为当地的一切都没有改变。
  const extensionCatalogContext = useContext(ExtensionCatalogContext);
  useEffect(() => {
    // 如果我们没有稳定的空别名函数
    const emptyAliasFunctions: Immutable<TopicAliasFunctions> = [];

    // 我们只想在函数发生变化时在播放器上设置别名函数
    let topicAliasFunctions =
      extensionCatalogContext.getState().installedTopicAliasFunctions ?? emptyAliasFunctions;
    topicAliasPlayer?.setAliasFunctions(topicAliasFunctions);

    return extensionCatalogContext.subscribe((state) => {
      if (topicAliasFunctions !== state.installedTopicAliasFunctions) {
        topicAliasFunctions = state.installedTopicAliasFunctions ?? emptyAliasFunctions;
        topicAliasPlayer?.setAliasFunctions(topicAliasFunctions);
      }
    });
  }, [extensionCatalogContext, topicAliasPlayer]);

  const player = useMemo(() => {
    if (!topicAliasPlayer) {
      return undefined;
    }

    return wrapPlayer(topicAliasPlayer);
  }, [topicAliasPlayer, wrapPlayer]);

  const { enqueueSnackbar } = useSnackbar();

  const [selectedSource, setSelectedSource] = useState<IDataSourceFactory | undefined>();
  // 上传ros2文件的时候触发这个函数
  const selectSource = useCallback(
    async (sourceId: string, args?: DataSourceArgs) => {
      console.log("Select Source:", sourceId, args);

      const foundSource = playerSources.find(
        (source) => source.id === sourceId || source.legacyIds?.includes(sourceId),
      );
      if (!foundSource) {
        enqueueSnackbar(`Unknown data source: ${sourceId}`, { variant: "warning" });
        return;
      }

      metricsCollector.setProperty("player", sourceId);

      setSelectedSource(foundSource);

      // 示例源不需要参数或提示进行初始化
      if (foundSource.type === "sample") {
        const newPlayer = foundSource.initialize({
          metricsCollector,
        });

        setBasePlayer(newPlayer);
        return;
      }

      if (!args) {
        enqueueSnackbar("Unable to initialize player: no args", { variant: "error" });
        setSelectedSource(undefined);
        return;
      }

      try {
        switch (args.type) {
          case "connection": {
            console.log("connection--1");

            const newPlayer = foundSource.initialize({
              metricsCollector,
              params: args.params,
            });
            setBasePlayer(newPlayer);

            if (args.params?.url) {
              addRecent({
                type: "connection",
                sourceId: foundSource.id,
                title: args.params.url,
                label: foundSource.displayName,
                extra: args.params,
              });
            }

            return;
          }
          case "file": {
            console.log("file--1");

            const handle = args.handle;
            const files = args.files;

            // 我们可以立即尝试加载的文件
            // 我们不将这些添加到最近项中，因为将File放入indexedb会导致
            // 整个文件被存储在数据库中。
            if (files) {
              console.log("file--2");

              let file = files[0];
              const fileList: File[] = [];

              for (const curFile of files) {
                file ??= curFile;
                fileList.push(curFile);
              }
              const multiFile = foundSource.supportsMultiFile === true && fileList.length > 1;

              const newPlayer = foundSource.initialize({
                file: multiFile ? undefined : file,
                files: multiFile ? fileList : undefined,
                metricsCollector,
              });

              setBasePlayer(newPlayer);
              return;
            } else if (handle) {
              console.log("file--3");

              // 在下面处理
              const permission = await handle.queryPermission({ mode: "read" });
              if (!isMounted()) {
                return;
              }

              if (permission !== "granted") {
                const newPerm = await handle.requestPermission({ mode: "read" });
                if (newPerm !== "granted") {
                  throw new Error(`Permission denied: ${handle.name}`);
                }
              }

              const file = await handle.getFile();
              if (!isMounted()) {
                return;
              }
              // 这个地方很重要 Ros2LocalBagDataSourceFactory 这个文件有关
              // 初始化
              const newPlayer = foundSource.initialize({
                file,
                metricsCollector,
              });
              // 这就是设置播放器
              setBasePlayer(newPlayer);
              // 添加 保存
              addRecent({
                type: "file",
                title: handle.name,
                sourceId: foundSource.id,
                handle,
              });

              return;
            }
          }
        }

        enqueueSnackbar("Unable to initialize player", { variant: "error" });
      } catch (error) {
        enqueueSnackbar((error as Error).message, { variant: "error" });
      }
    },
    [playerSources, metricsCollector, enqueueSnackbar, isMounted, addRecent],
  );

  // 按id选择最近的条目
  // 必须退出回调创建，以避免在闭包上下文中捕获初始播放器
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selectRecent = useCallback(
    // 这里是这个函数的return
    createSelectRecentCallback(recents, selectSource, enqueueSnackbar),
    [recents, enqueueSnackbar, selectSource],
  );

  // 为PlayerSelectionContext制作RecentSources数组
  const recentSources = useMemo(() => {
    return recents.map((item) => {
      return { id: item.id, title: item.title, label: item.label };
    });
  }, [recents]);

  const value: PlayerSelection = {
    selectSource,
    selectRecent,
    selectedSource,
    availableSources: playerSources,
    recentSources,
  };

  return (
    <>
      <PlayerSelectionContext.Provider value={value}>
        <MessagePipelineProvider player={player}>{children}</MessagePipelineProvider>
      </PlayerSelectionContext.Provider>
    </>
  );
}

/**
 * 由于在Start.tsx的已存储状态下发生内存泄漏，这已从PlayerManager函数中移出
 *那就是保留老玩家的实例。在PlayerManager中定义此回调使其存储
 *在闭包上下文中实例化的播放器。然后，该回调与它的闭包上下文一起存储在记忆状态中。
 *当播放器发生变化，但“Start.tsx”的一部分保留了以前的记忆状态时，回调会更新
 *未知原因。
 *为了使该函数安全地避免在组件中以旧的记忆状态存储旧的闭包上下文
 *已被移出PlayerManager功能。
 */
function createSelectRecentCallback(
  recents: RecentRecord[],
  selectSource: (sourceId: string, dataSourceArgs: DataSourceArgs) => Promise<void>,
  enqueueSnackbar: ReturnType<typeof useSnackbar>["enqueueSnackbar"],
) {
  console.log("createSelectRecentCallback", recents);

  return (recentId: string) => {
    // selectRecent 传过来的recentId
    // 先执行的这个
    console.log("createSelectRecentCallback2", recentId);
    // 从列表中查找最近的并初始化
    const foundRecent = recents.find((value) => value.id === recentId);
    if (!foundRecent) {
      enqueueSnackbar(`Failed to restore recent: ${recentId}`, { variant: "error" });
      return;
    }

    switch (foundRecent.type) {
      case "connection": {
        void selectSource(foundRecent.sourceId, {
          type: "connection",
          params: foundRecent.extra,
        });
        break;
      }
      case "file": {
        void selectSource(foundRecent.sourceId, {
          type: "file",
          handle: foundRecent.handle,
        });
      }
    }
  };
}
