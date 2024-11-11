// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
// 用于webworker的第三方封装库aa
import * as Comlink from "comlink";

import { abortSignalTransferHandler } from "@foxglove/comlink-transfer-handlers";
import { Immutable, MessageEvent, Time } from "@foxglove/studio";

import type {
  GetBackfillMessagesArgs,
  IIterableSource,
  IMessageCursor,
  Initalization,
  IteratorResult,
  MessageIteratorArgs,
  IterableSourceInitializeArgs,
} from "./IIterableSource";
import type { WorkerIterableSourceWorker } from "./WorkerIterableSourceWorker";

Comlink.transferHandlers.set("abortsignal", abortSignalTransferHandler);

type ConstructorArgs = {
  initWorker: () => Worker;
  initArgs: IterableSourceInitializeArgs;
};

export class WorkerIterableSource implements IIterableSource {
  readonly #args: ConstructorArgs;

  #thread?: Worker;
  #worker?: Comlink.Remote<WorkerIterableSourceWorker>;
  // 构造函数，放了一个initWorker函数在里面
  public constructor(args: ConstructorArgs) {
    this.#args = args;
  }
  /**
   * 异步初始化方法
   *
   * 本方法主要用于初始化WorkerIterableSource，包括启动工作者(Worker)并进行必要的初始化配置
   * 使用了Comlink库来实现主线程与工作者线程之间的通信
   *
   * @returns {Promise<Initalization>} 返回一个Promise，解析为初始化结果
 */
  public async initialize(): Promise<Initalization> {
    console.log("WorkerIterableSource--initialize");

    // 注意：这将启动工作者。
    this.#thread = this.#args.initWorker();
    // 使用Comlink.wrap包装工作者线程，以实现远程调用
    // 该方法允许我们向工作者线程发送初始化参数，并等待其初始化完成
    const initialize = Comlink.wrap<
      (args: IterableSourceInitializeArgs) => Comlink.Remote<WorkerIterableSourceWorker>
    >(this.#thread);
    // const initialize = Comlink.wrap(this.#thread);
    // 调用工作者线程的初始化方法，并等待其完成
    // 注意：这里我们传递初始化所需的参数，并在当前上下文中保留工作者的引用
    const worker = (this.#worker = await initialize(this.#args.initArgs));
    return await worker.initialize();
  }

  public async *messageIterator(
    args: MessageIteratorArgs,
  ): AsyncIterableIterator<Readonly<IteratorResult>> {
    if (this.#worker == undefined) {
      throw new Error(`WorkerIterableSource is not initialized`);
    }

    const cursor = this.getMessageCursor(args);
    try {
      for (; ;) {
        // The fastest framerate that studio renders at is 60fps. So to render a frame studio needs
        // at minimum ~16 milliseconds of messages before it will render a frame. Here we fetch
        // batches of 17 milliseconds so that one batch fetch could result in one frame render.
        // Fetching too much in a batch means we cannot render until the batch is returned.
        const results = await cursor.nextBatch(17 /* milliseconds */);
        if (!results || results.length === 0) {
          break;
        }
        yield* results;
      }
    } finally {
      await cursor.end();
    }
  }

  public async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    if (this.#worker == undefined) {
      throw new Error(`WorkerIterableSource is not initialized`);
    }

    // An AbortSignal is not clonable, so we remove it from the args and send it as a separate argumet
    // to our worker getBackfillMessages call. Our installed Comlink handler for AbortSignal handles
    // making the abort signal available within the worker.
    const { abortSignal, ...rest } = args;
    return await this.#worker.getBackfillMessages(rest, abortSignal);
  }

  public getMessageCursor(
    args: Immutable<MessageIteratorArgs & { abort?: AbortSignal }>,
  ): IMessageCursor {
    if (this.#worker == undefined) {
      throw new Error(`WorkerIterableSource is not initialized`);
    }

    // An AbortSignal is not clonable, so we remove it from the args and send it as a separate argumet
    // to our worker getBackfillMessages call. Our installed Comlink handler for AbortSignal handles
    // making the abort signal available within the worker.
    const { abort, ...rest } = args;
    const messageCursorPromise = this.#worker.getMessageCursor(rest, abort);

    const cursor: IMessageCursor = {
      async next() {
        const messageCursor = await messageCursorPromise;
        return await messageCursor.next();
      },

      async nextBatch(durationMs: number) {
        const messageCursor = await messageCursorPromise;
        return await messageCursor.nextBatch(durationMs);
      },

      async readUntil(end: Time) {
        const messageCursor = await messageCursorPromise;
        return await messageCursor.readUntil(end);
      },

      async end() {
        const messageCursor = await messageCursorPromise;
        try {
          await messageCursor.end();
        } finally {
          messageCursor[Comlink.releaseProxy]();
        }
      },
    };

    return cursor;
  }

  public async terminate(): Promise<void> {
    this.#thread?.terminate();
  }

}
