// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ROS2_TO_DEFINITIONS, Rosbag2, SqliteSqljs } from "@foxglove/rosbag2-web";
import { stringify } from "@foxglove/rosmsg";
import { Time, add as addTime } from "@foxglove/rostime";
import { MessageEvent } from "@foxglove/studio";
import { estimateObjectSize } from "@foxglove/studio-base/players/messageMemoryEstimation";
import {
  MessageDefinitionsByTopic,
  ParsedMessageDefinitionsByTopic,
  PlayerProblem,
  Topic,
  TopicStats,
} from "@foxglove/studio-base/players/types";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";
import { basicDatatypes } from "@foxglove/studio-base/util/basicDatatypes";

import {
  IIterableSource,
  IteratorResult,
  Initalization,
  MessageIteratorArgs,
  GetBackfillMessagesArgs,
} from "../IIterableSource";

export class RosDb3IterableSource implements IIterableSource {
  #files: File[];
  #bag?: Rosbag2;
  #start: Time = { sec: 0, nsec: 0 };
  #end: Time = { sec: 0, nsec: 0 };
  #messageSizeEstimateByTopic: Record<string, number> = {};

  public constructor(files: File[]) {
    this.#files = files;
  }
  /*
    这段 TypeScript 代码定义了一个异步方法 initialize，用于初始化一个 ROS2 数据源。主要功能包括：

    加载 SQLite WASM 模块：从指定 URL 加载 SQLite 的 WebAssembly 模块。
    打开数据库文件：创建并打开 SQLite 数据库文件，然后使用这些文件创建一个 Rosbag2 对象。
    获取时间范围和主题信息：从 Rosbag2 对象中获取数据的时间范围、主题定义和消息计数。
    检查消息数量：确保至少有一个消息，否则抛出错误。
    处理主题定义：遍历所有主题定义，检查每个主题的消息类型是否支持，如果不支持则记录问题。
    构建返回对象：构建并返回一个包含主题、统计信息、时间范围、问题、数据类型等信息的对象。
  */
  public async initialize(): Promise<Initalization> {
    console.log("RosDb3IterableSource--initialize, worker内容主要在这里执行");
    const aa = new URL("@foxglove/sql.js/dist/sql-wasm.wasm", import.meta.url).toString();
    console.log('aa--->', aa);

    const res = await fetch(
      // foxglove-depcheck-used: babel-plugin-transform-import-meta
      new URL("@foxglove/sql.js/dist/sql-wasm.wasm", import.meta.url).toString(),
    );
    console.log('res--->', res);

    const sqlWasm = await (await res.blob()).arrayBuffer();
    await SqliteSqljs.Initialize({ wasmBinary: sqlWasm });
    // 根子 处理  .db3 文件
    const dbs = this.#files.map((file) => new SqliteSqljs(file));
    const bag = new Rosbag2(dbs);
    await bag.open();
    this.#bag = bag;

    const [start, end] = await this.#bag.timeRange();
    const topicDefs = await this.#bag.readTopics();
    const messageCounts = await this.#bag.messageCounts();
    let hasAnyMessages = false;
    for (const count of messageCounts.values()) {
      if (count > 0) {
        hasAnyMessages = true;
        break;
      }
    }
    if (!hasAnyMessages) {
      throw new Error("Bag contains no messages");
    }

    const problems: PlayerProblem[] = [];
    const topics: Topic[] = [];
    const topicStats = new Map<string, TopicStats>();
    // ROS2.db3文件不包含消息定义，因此我们只能支持众所周知的ROS类型。
    const datatypes: RosDatatypes = new Map([...ROS2_TO_DEFINITIONS, ...basicDatatypes]);
    const messageDefinitionsByTopic: MessageDefinitionsByTopic = {};
    const parsedMessageDefinitionsByTopic: ParsedMessageDefinitionsByTopic = {};
    // 在这
    for (const topicDef of topicDefs) {
      const numMessages = messageCounts.get(topicDef.name);

      topics.push({ name: topicDef.name, schemaName: topicDef.type });
      if (numMessages != undefined) {
        topicStats.set(topicDef.name, { numMessages });
      }

      const parsedMsgdef = datatypes.get(topicDef.type);
      if (parsedMsgdef == undefined) {
        problems.push({
          severity: "warn",
          message: `Topic "${topicDef.name}" has unsupported datatype "${topicDef.type}"`,
          tip: "ROS 2 .db3 files do not contain message definitions, so only well-known ROS types are supported in Foxglove Studio. As a workaround, you can convert the db3 file to mcap using the mcap CLI. For more information, see: https://docs.foxglove.dev/docs/connecting-to-data/frameworks/ros2",
        });
        continue;
      }

      const fullParsedMessageDefinitions = [parsedMsgdef];
      const messageDefinition = stringify(fullParsedMessageDefinitions);
      datatypes.set(topicDef.type, { name: topicDef.type, definitions: parsedMsgdef.definitions });
      messageDefinitionsByTopic[topicDef.name] = messageDefinition;
      parsedMessageDefinitionsByTopic[topicDef.name] = fullParsedMessageDefinitions;
    }

    this.#start = start;
    this.#end = end;

    return {
      topics: Array.from(topics.values()),
      topicStats,
      start,
      end,
      problems,
      profile: "ros2",
      datatypes,
      publishersByTopic: new Map(),
    };
  }

  public async *messageIterator(
    opt: MessageIteratorArgs,
  ): AsyncIterableIterator<Readonly<IteratorResult>> {
    if (this.#bag == undefined) {
      throw new Error(`Rosbag2DataProvider is not initialized`);
    }

    const topics = opt.topics;
    if (topics.size === 0) {
      return;
    }

    const start = opt.start ?? this.#start;
    const end = opt.end ?? this.#end;

    // Add 1 nsec to the end time because rosbag2 treats the time range as non-inclusive
    // of the exact end time.
    const inclusiveEndTime = addTime(end, { sec: 0, nsec: 1 });
    const msgIterator = this.#bag.readMessages({
      startTime: start,
      endTime: inclusiveEndTime,
      topics: Array.from(topics.keys()),
    });
    for await (const msg of msgIterator) {
      // Lookup the size estimate for this topic or compute it if not found in the cache.
      let msgSizeEstimate = this.#messageSizeEstimateByTopic[msg.topic.name];
      if (msgSizeEstimate == undefined) {
        msgSizeEstimate = estimateObjectSize(msg.value);
        this.#messageSizeEstimateByTopic[msg.topic.name] = msgSizeEstimate;
      }

      yield {
        type: "message-event",
        msgEvent: {
          topic: msg.topic.name,
          receiveTime: msg.timestamp,
          message: msg.value,
          sizeInBytes: Math.max(msg.data.byteLength, msgSizeEstimate),
          schemaName: msg.topic.type,
        },
      };
    }
  }

  public async getBackfillMessages(_args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    return [];
  }
}
