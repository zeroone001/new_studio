// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  IDataSourceFactory,
  DataSourceFactoryInitializeArgs,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { IterablePlayer, WorkerIterableSource } from "@foxglove/studio-base/players/IterablePlayer";
import { Player } from "@foxglove/studio-base/players/types";

// 定义一个处理ros2本地bag文件的类
// IDataSourceFactory是一个接口，这个接口定义了一些属性，这个类实现了这个接口，
// 所以这个类可以作为数据源工厂
class Ros2LocalBagDataSourceFactory implements IDataSourceFactory {
  public id = "ros2-local-bagfile";
  public type: IDataSourceFactory["type"] = "file";
  public displayName = "ROS 2 Bag";
  public iconName: IDataSourceFactory["iconName"] = "OpenFile";
  public supportedFileTypes = [".db3"];
  public supportsMultiFile = true;
  // 在packages/studio-base/src/components/PlayerManager.tsx 这里执行的这个方法
  public initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    const files = args.file ? [args.file] : args.files;
    // 从这里开始，真正的数据就是这个 files
    console.log("Ros2LocalBagDataSourceFactory--initialize--files", files);

    const name = args.file ? args.file.name : args.files?.map((file) => file.name).join(", ");

    if (!files) {
      return;
    }

    const source = new WorkerIterableSource({
      // 创建webworker线程
      initWorker: () => {
        return new Worker(
          // foxglove-depcheck-used: babel-plugin-transform-import-meta
          new URL(
            "@foxglove/studio-base/players/IterablePlayer/rosdb3/RosDb3IterableSourceWorker.worker",
            import.meta.url,
          ),
        );
      },
      initArgs: { files },
    });
    // 创建一个IterablePlayer
    console.log("创建一个IterablePlayer-->source", source);

    return new IterablePlayer({
      metricsCollector: args.metricsCollector,
      source,
      name,
      sourceId: this.id,
    });
  }
}

export default Ros2LocalBagDataSourceFactory;
