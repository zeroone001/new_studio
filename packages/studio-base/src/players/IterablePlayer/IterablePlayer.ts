// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import assert from "assert";
import * as _ from "lodash-es";
import { v4 as uuidv4 } from "uuid";

import { debouncePromise } from "@foxglove/den/async";
import { filterMap } from "@foxglove/den/collection";
import Log from "@foxglove/log";
import {
  Time,
  add,
  clampTime,
  compare,
  fromMillis,
  fromNanoSec,
  toRFC3339String,
  toString,
} from "@foxglove/rostime";
import { Immutable, MessageEvent, ParameterValue } from "@foxglove/studio";
import NoopMetricsCollector from "@foxglove/studio-base/players/NoopMetricsCollector";
import PlayerProblemManager from "@foxglove/studio-base/players/PlayerProblemManager";
import {
  AdvertiseOptions,
  Player,
  PlayerCapabilities,
  PlayerMetricsCollectorInterface,
  PlayerPresence,
  PlayerState,
  PlayerStateActiveData,
  Progress,
  PublishPayload,
  SubscribePayload,
  Topic,
  TopicSelection,
  TopicStats,
} from "@foxglove/studio-base/players/types";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";
import delay from "@foxglove/studio-base/util/delay";

import { BlockLoader } from "./BlockLoader";
import { BufferedIterableSource } from "./BufferedIterableSource";
import { IIterableSource, IteratorResult } from "./IIterableSource";

const log = Log.getLogger(__filename);

// Number of bytes that we aim to keep in the cache.
// Setting this to higher than 1.5GB caused the renderer process to crash on linux.
// See: https://github.com/foxglove/studio/pull/1733
const DEFAULT_CACHE_SIZE_BYTES = 1.0e9;

// Amount to wait until panels have had the chance to subscribe to topics before
// we start playback
const START_DELAY_MS = 100;

// Messages are laid out in blocks with a fixed number of milliseconds.
const MIN_MEM_CACHE_BLOCK_SIZE_NS = 0.1e9;

// Original comment from webviz:
// Preloading algorithms slow when there are too many blocks.
// Adaptive block sizing is simpler than using a tree structure for immutable updates but
// less flexible, so we may want to move away from a single-level block structure in the future.
const MAX_BLOCKS = 400;

// Amount to seek into the data source from the start when loading the player. The purpose of this
// is to provide some initial data to subscribers.
const SEEK_ON_START_NS = BigInt(99 * 1e6);

const MEMORY_INFO_BUFFERED_MSGS = "Buffered messages";

const EMPTY_ARRAY = Object.freeze([]);

type IterablePlayerOptions = {
  metricsCollector?: PlayerMetricsCollectorInterface;

  source: IIterableSource;

  // Optional player name
  name?: string;

  // Optional set of key/values to store with url handling
  urlParams?: Record<string, string>;

  // Source identifier used in constructing state urls.
  sourceId: string;

  isSampleDataSource?: boolean;

  // Set to _false_ to disable preloading. (default: true)
  enablePreload?: boolean;
};

type IterablePlayerState =
  | "preinit"
  | "initialize"
  | "start-play"
  | "idle"
  | "seek-backfill"
  | "play"
  | "close"
  | "reset-playback-iterator";

/**
 * IterablePlayer实现了IIterableSource实例的Player接口。
 *
 * 可迭代播放器从IIterableSource读取消息。播放器被实现为一个状态
 * 机器每个状态一直运行到结束。更改状态的请求由每个状态处理
 * 检测到有另一个状态在等待并且协作地结束其自身。
 */
export class IterablePlayer implements Player {
  #urlParams?: Record<string, string>;
  #name?: string;
  #nextState?: IterablePlayerState;
  #state: IterablePlayerState = "preinit";
  #runningState: boolean = false;

  #isPlaying: boolean = false;
  #listener?: (playerState: PlayerState) => Promise<void>;
  #speed: number = 1.0;
  #start?: Time;
  #end?: Time;
  #enablePreload = true;

  // next read start time indicates where to start reading for the next tick
  // after a tick read, it is set to 1nsec past the end of the read operation (preparing for the next tick)
  #lastTickMillis?: number;
  // This is the "lastSeekTime" emitted in the playerState. This indicates the emit is due to a seek.
  #lastSeekEmitTime: number = Date.now();

  #providerTopics: Topic[] = [];
  #providerTopicStats = new Map<string, TopicStats>();
  #providerDatatypes: RosDatatypes = new Map();

  #capabilities: string[] = [PlayerCapabilities.setSpeed, PlayerCapabilities.playbackControl];
  #profile: string | undefined;
  #metricsCollector: PlayerMetricsCollectorInterface;
  #subscriptions: SubscribePayload[] = [];
  #allTopics: TopicSelection = new Map();
  #preloadTopics: TopicSelection = new Map();

  #progress: Progress = {};
  #id: string = uuidv4();
  #messages: Immutable<MessageEvent[]> = [];
  #receivedBytes: number = 0;
  #hasError = false;
  #lastRangeMillis?: number;
  #lastMessageEvent?: MessageEvent;
  #lastStamp?: Time;
  #publishedTopics = new Map<string, Set<string>>();
  #seekTarget?: Time;
  #presence = PlayerPresence.INITIALIZING;

  // To keep reference equality for downstream user memoization cache the currentTime provided in the last activeData update
  // See additional comments below where _currentTime is set
  #currentTime?: Time;

  #problemManager = new PlayerProblemManager();

  #iterableSource: IIterableSource;
  #bufferedSource: BufferedIterableSource;

  // Some states register an abort controller to signal they should abort
  #abort?: AbortController;

  // 用于在播放期间读取消息的迭代器
  #playbackIterator?: AsyncIterator<Readonly<IteratorResult>>;

  #blockLoader?: BlockLoader;
  #blockLoadingProcess?: Promise<void>;

  #queueEmitState: ReturnType<typeof debouncePromise>;

  readonly #sourceId: string;

  #untilTime?: Time;

  /** Promise that resolves when the player is closed. Only used for testing currently */
  public readonly isClosed: Promise<void>;
  #resolveIsClosed: () => void = () => {};

  public constructor(options: IterablePlayerOptions) {
    const { metricsCollector, urlParams, source, name, enablePreload, sourceId } = options;
    // 这个source才是核心
    this.#iterableSource = source;
    // 把Source的能力传到了这里
    this.#bufferedSource = new BufferedIterableSource(source);
    this.#name = name;
    this.#urlParams = urlParams;
    this.#metricsCollector = metricsCollector ?? new NoopMetricsCollector();
    this.#metricsCollector.playerConstructed();
    this.#enablePreload = enablePreload ?? true;
    this.#sourceId = sourceId;

    this.isClosed = new Promise((resolveClose) => {
      this.#resolveIsClosed = resolveClose;
    });

    // 包装emitStateImpl在一个debouncePromise中为我们的州调用。因为我们可以从国家排放
    // 或者通过块加载更新，我们使用debouncePromise来防止并发发射。
    this.#queueEmitState = debouncePromise(this.#emitStateImpl.bind(this));
  }
  // 设置监听
  public setListener(listener: (playerState: PlayerState) => Promise<void>): void {
    console.log("setListener---->1");

    if (this.#listener) {
      throw new Error("Cannot setListener again");
    }
    this.#listener = listener;
    this.#setState("initialize");
  }
  // 开始播放 ，这个函数面向外面使用
  public startPlayback(): void {
    console.log("startPlayback---->2");
    this.#startPlayImpl();
  }

  public playUntil(time: Time): void {
    this.#startPlayImpl({ untilTime: time });
  }
  // 开始播放
  #startPlayImpl(opt?: { untilTime: Time }): void {
    if (this.#isPlaying || this.#untilTime != undefined || !this.#start || !this.#end) {
      return;
    }

    if (opt?.untilTime) {
      if (this.#currentTime && compare(opt.untilTime, this.#currentTime) <= 0) {
        throw new Error("Invariant: playUntil time must be after the current time");
      }
      this.#untilTime = clampTime(opt.untilTime, this.#start, this.#end);
    }
    //
    console.log("startPlayImpl---->3");
    this.#metricsCollector.play(this.#speed);
    this.#isPlaying = true;

    // 如果我们空闲，我们可以开始玩，如果我们有下一个状态排队，我们让那个状态
    // 完成比赛，我们就可以上场了
    if (this.#state === "idle" && (!this.#nextState || this.#nextState === "idle")) {
      this.#setState("play");
    } else {
      this.#queueEmitState(); // 将isPlaying状态更新为UI
    }
  }
  // 暂停播放
  public pausePlayback(): void {
    console.log("pausePlayback---->4");

    if (!this.#isPlaying) {
      return;
    }
    this.#metricsCollector.pause();
    // clear out last tick millis so we don't read a huge chunk when we unpause
    this.#lastTickMillis = undefined;
    this.#isPlaying = false;
    this.#untilTime = undefined;
    this.#lastRangeMillis = undefined;
    if (this.#state === "play") {
      this.#setState("idle");
    } else {
      this.#queueEmitState(); // update isPlaying state to UI
    }
  }
  // 设置播放速度 这个函数是在外面用修改播放速度的
  public setPlaybackSpeed(speed: number): void {
    console.log("setPlaybackSpeed---->5");

    this.#lastRangeMillis = undefined;
    this.#speed = speed;
    this.#metricsCollector.setSpeed(speed);

    // 这个函数用来去触发修改UI的，在class里这个函数使用了最多的次数
    // 在这个class里一切的事情都是为了去触发这个函数
    this.#queueEmitState();
  }

  public seekPlayback(time: Time): void {
    console.log("seekPlayback---->6");

    // Wait to perform seek until initialization is complete
    if (this.#state === "preinit" || this.#state === "initialize") {
      log.debug(`Ignoring seek, state=${this.#state}`);
      this.#seekTarget = time;
      return;
    }

    if (!this.#start || !this.#end) {
      throw new Error("invariant: initialized but no start/end set");
    }

    // 将查找限制在有效范围内
    const targetTime = clampTime(time, this.#start, this.#end);

    // 我们已经在寻求这个时候，没有必要重新设置寻求
    if (this.#seekTarget && compare(this.#seekTarget, targetTime) === 0) {
      log.debug(`Ignoring seek, already seeking to this time`);
      return;
    }

    // We are already at this time, no need to reset seeking
    if (this.#currentTime && compare(this.#currentTime, targetTime) === 0) {
      log.debug(`Ignoring seek, already at this time`);
      return;
    }

    this.#metricsCollector.seek(targetTime);
    this.#seekTarget = targetTime;
    this.#untilTime = undefined;
    this.#lastTickMillis = undefined;
    this.#lastRangeMillis = undefined;

    this.#setState("seek-backfill");
  }

  public setSubscriptions(newSubscriptions: SubscribePayload[]): void {
    console.log("setSubscriptions---->7");

    log.debug("set subscriptions", newSubscriptions);
    this.#subscriptions = newSubscriptions;
    this.#metricsCollector.setSubscriptions(newSubscriptions);

    const allTopics: TopicSelection = new Map(
      this.#subscriptions.map((subscription) => [subscription.topic, subscription]),
    );
    const preloadTopics = new Map(
      filterMap(this.#subscriptions, (sub) =>
        sub.preloadType === "full" ? [sub.topic, sub] : undefined,
      ),
    );

    // If there are no changes to topics there's no reason to perform a "seek" to trigger loading
    if (_.isEqual(allTopics, this.#allTopics) && _.isEqual(preloadTopics, this.#preloadTopics)) {
      return;
    }

    this.#allTopics = allTopics;
    this.#preloadTopics = preloadTopics;
    this.#blockLoader?.setTopics(this.#preloadTopics);

    // 如果播放器正在播放，播放状态将检测到任何订阅更改并进行调整
    //迭代器。然而，如果我们空闲或已经在寻找，那么我们需要手动
    //触发回填。
    if (
      this.#state === "idle" ||
      this.#state === "seek-backfill" ||
      this.#state === "play" ||
      this.#state === "start-play"
    ) {
      if (!this.#isPlaying && this.#currentTime) {
        this.#seekTarget ??= this.#currentTime;
        this.#untilTime = undefined;
        this.#lastTickMillis = undefined;
        this.#lastRangeMillis = undefined;

        // Trigger a seek backfill to load any missing messages and reset the forward iterator
        this.#setState("seek-backfill");
      }
    }
  }

  public setPublishers(_publishers: AdvertiseOptions[]): void {
    // no-op
  }

  public setParameter(_key: string, _value: ParameterValue): void {
    throw new Error("Parameter editing is not supported by this data source");
  }

  public publish(_payload: PublishPayload): void {
    throw new Error("Publishing is not supported by this data source");
  }

  public async callService(): Promise<unknown> {
    throw new Error("Service calls are not supported by this data source");
  }

  public close(): void {
    console.log("close---->8");

    this.#setState("close");
  }

  public setGlobalVariables(): void {
    // no-op
  }

  /** 请求状态切换到newState */
  #setState(newState: IterablePlayerState) {
    // log.debug(`设置下个状态: ${newState}`);
    console.log(`设置下个状态: ${newState}`);
    // 任何东西都不应该超过关闭播放器
    if (this.#nextState === "close") {
      return;
    }

    this.#nextState = newState;
    // 中止
    // 中止一个尚未完成的 Web（网络）请求。这能够中止 fetch 请求及任何响应体的消费和流。
    this.#abort?.abort();
    this.#abort = undefined;
    void this.#runState();
  }

  /**
   * 在有状态要运行时运行请求的状态。
   * 确保一次只运行一个状态。
   * */
  async #runState() {
    console.log(`runState---->9`);

    if (this.#runningState) {
      return;
    }

    this.#runningState = true;
    try {
      while (this.#nextState) {
        const state = (this.#state = this.#nextState);
        this.#nextState = undefined;

        log.debug(`Start state: ${state}`);

        // 如果我们进入播放或空闲以外的状态，我们将丢弃播放迭代器，因为
        //我们需要做一个新的
        if (state !== "idle" && state !== "play" && this.#playbackIterator) {
          log.debug("Ending playback iterator because next state is not IDLE or PLAY");
          await this.#playbackIterator.return?.();
          this.#playbackIterator = undefined;
        }

        switch (state) {
          case "preinit":
            this.#queueEmitState();
            break;
          case "initialize":
            await this.#stateInitialize();
            break;
          case "start-play":
            await this.#stateStartPlay();
            break;
          case "idle":
            await this.#stateIdle();
            break;
          case "seek-backfill":
            // We allow aborting requests when moving on to the next state
            await this.#stateSeekBackfill();
            break;
          case "play":
            await this.#statePlay();
            break;
          case "close":
            await this.#stateClose();
            break;
          case "reset-playback-iterator":
            await this.#stateResetPlaybackIterator();
        }
        console.log(`Done state ${state}`);

        // log.debug();
      }
    } catch (err) {
      log.error(err);
      this.#setError((err as Error).message, err);
      this.#queueEmitState();
    } finally {
      this.#runningState = false;
    }
  }

  #setError(message: string, error?: Error): void {
    this.#hasError = true;
    this.#problemManager.addProblem("global-error", {
      severity: "error",
      message,
      error,
    });
    this.#isPlaying = false;
  }

  // 初始化源和玩家成员
  async #stateInitialize(): Promise<void> {
    // 这个函数确实是先触发的，在上传本地文件的时候就触发了
    console.log("初始化stateInitialize");

    // 指示初始化开始的发射状态
    this.#queueEmitState();

    try {
      const {
        start,
        end,
        topics,
        profile,
        topicStats,
        problems,
        publishersByTopic,
        datatypes,
        name,
      } = await this.#bufferedSource.initialize();

      // 在初始化之前，seekTarget可能已设置为越界值
      //这使值处于界限内
      if (this.#seekTarget) {
        this.#seekTarget = clampTime(this.#seekTarget, start, end);
      }

      this.#profile = profile;
      this.#start = start;
      this.#currentTime = this.#seekTarget ?? start;
      this.#end = end;
      this.#publishedTopics = publishersByTopic;
      this.#providerDatatypes = datatypes;
      this.#name = name ?? this.#name;

      // Studio does not like duplicate topics or topics with different datatypes
      // Check for duplicates or for mismatched datatypes
      const uniqueTopics = new Map<string, Topic>();
      for (const topic of topics) {
        const existingTopic = uniqueTopics.get(topic.name);
        if (existingTopic) {
          problems.push({
            severity: "warn",
            message: `Inconsistent datatype for topic: ${topic.name}`,
            tip: `Topic ${topic.name} has messages with multiple datatypes: ${existingTopic.schemaName}, ${topic.schemaName}. This may result in errors during visualization.`,
          });
          continue;
        }

        uniqueTopics.set(topic.name, topic);
      }

      this.#providerTopics = Array.from(uniqueTopics.values());
      this.#providerTopicStats = topicStats;

      let idx = 0;
      for (const problem of problems) {
        this.#problemManager.addProblem(`init-problem-${idx}`, problem);
        idx += 1;
      }

      if (this.#enablePreload) {
        // --- setup block loader which loads messages for _full_ subscriptions in the "background"
        try {
          this.#blockLoader = new BlockLoader({
            cacheSizeBytes: DEFAULT_CACHE_SIZE_BYTES,
            source: this.#iterableSource,
            start: this.#start,
            end: this.#end,
            maxBlocks: MAX_BLOCKS,
            minBlockDurationNs: MIN_MEM_CACHE_BLOCK_SIZE_NS,
            problemManager: this.#problemManager,
          });
        } catch (err) {
          log.error(err);

          const startStr = toRFC3339String(this.#start);
          const endStr = toRFC3339String(this.#end);

          this.#problemManager.addProblem("block-loader", {
            severity: "warn",
            message: "Failed to initialize message preloading",
            tip: `The start (${startStr}) and end (${endStr}) of your data is too far apart.`,
            error: err,
          });
        }
      }

      this.#presence = PlayerPresence.PRESENT;
    } catch (error) {
      this.#setError(`Error initializing: ${error.message}`, error);
    }
    this.#queueEmitState();

    if (!this.#hasError && this.#start) {
      // Wait a bit until panels have had the chance to subscribe to topics before we start
      // playback.
      await delay(START_DELAY_MS);

      this.#blockLoader?.setTopics(this.#preloadTopics);

      // Block loadings is constantly running and tries to keep the preloaded messages in memory
      this.#blockLoadingProcess = this.#startBlockLoading().catch((err) => {
        this.#setError((err as Error).message, err as Error);
      });

      this.#setState("start-play");
    }
  }

  async #resetPlaybackIterator() {
    console.log("resetPlaybackIterator--->");

    if (!this.#currentTime) {
      throw new Error("Invariant: Tried to reset playback iterator with no current time.");
    }

    const next = add(this.#currentTime, { sec: 0, nsec: 1 });

    log.debug("Ending previous iterator");
    await this.#playbackIterator?.return?.();

    // set the playIterator to the seek time
    await this.#bufferedSource.stopProducer();

    log.debug("Initializing forward iterator from", next);
    this.#playbackIterator = this.#bufferedSource.messageIterator({
      topics: this.#allTopics,
      start: next,
      consumptionType: "partial",
    });
  }

  async #stateResetPlaybackIterator() {
    console.log("resetPlaybackIterator--->");

    if (!this.#currentTime) {
      throw new Error("Invariant: Tried to reset playback iterator with no current time.");
    }

    await this.#resetPlaybackIterator();
    this.#setState(this.#isPlaying ? "play" : "idle");
  }

  // 从数据源中读取少量数据，希望能生成一两条消息。
  //如果没有初始阅读，用户将看到一个空白布局，因为还没有消息
  //已交付。
  async #stateStartPlay() {
    // 这个函数在打开本地文件的时候就会执行到这里
    console.log("啦啦啦Starting playback");

    if (!this.#start || !this.#end) {
      throw new Error("Invariant: start and end must be set");
    }

    // 如果我们有目标寻道时间，seekPlayback功能将负责回填消息。
    if (this.#seekTarget) {
      this.#setState("seek-backfill");
      return;
    }

    const stopTime = clampTime(
      add(this.#start, fromNanoSec(SEEK_ON_START_NS)),
      this.#start,
      this.#end,
    );

    log.debug(`Playing from ${toString(this.#start)} to ${toString(stopTime)}`);

    if (this.#playbackIterator) {
      throw new Error("Invariant. playbackIterator was already set");
    }

    log.debug("Initializing forward iterator from", this.#start);
    // 主要是这个
    this.#playbackIterator = this.#bufferedSource.messageIterator({
      topics: this.#allTopics,
      start: this.#start,
      consumptionType: "partial",
    });

    this.#lastMessageEvent = undefined;
    this.#messages = [];

    const messageEvents: MessageEvent[] = [];

    // If we take too long to read the data, we set the player into a BUFFERING presence. This
    // indicates that the player is waiting to load more data.
    const tickTimeout = setTimeout(() => {
      this.#presence = PlayerPresence.BUFFERING;
      this.#queueEmitState();
    }, 100);

    try {
      for (;;) {
        const result = await this.#playbackIterator.next();
        if (result.done === true) {
          break;
        }
        const iterResult = result.value;
        // Bail if a new state is requested while we are loading messages
        // This usually happens when seeking before the initial load is complete
        if (this.#nextState) {
          return;
        }

        if (iterResult.type === "problem") {
          this.#problemManager.addProblem(`connid-${iterResult.connectionId}`, iterResult.problem);
          continue;
        }

        if (iterResult.type === "stamp" && compare(iterResult.stamp, stopTime) >= 0) {
          this.#lastStamp = iterResult.stamp;
          break;
        }

        if (iterResult.type === "message-event") {
          // The message is past the tick end time, we need to save it for next tick
          if (compare(iterResult.msgEvent.receiveTime, stopTime) > 0) {
            this.#lastMessageEvent = iterResult.msgEvent;
            break;
          }

          messageEvents.push(iterResult.msgEvent);
        }
      }
    } finally {
      clearTimeout(tickTimeout);
    }

    this.#currentTime = stopTime;
    this.#messages = messageEvents;
    this.#presence = PlayerPresence.PRESENT;
    this.#queueEmitState();
    this.#setState("idle");
  }

  // 处理查找请求。通过从源请求getBackfillMessages来执行查找。
  // This provides the last message on all subscribed topics.
  async #stateSeekBackfill() {
    console.log("stateSeekBackfill--->");

    if (!this.#start || !this.#end) {
      throw new Error("invariant: stateSeekBackfill prior to initialization");
    }

    if (!this.#seekTarget) {
      return;
    }

    // Ensure the seek time is always within the data source bounds
    const targetTime = clampTime(this.#seekTarget, this.#start, this.#end);

    this.#lastMessageEvent = undefined;

    // If the backfill does not complete within 100 milliseconds, we emit with no messages to
    // indicate buffering. This provides feedback to the user that we've acknowledged their seek
    // request but haven't loaded the data.
    //
    // Note: we explicitly avoid setting _lastSeekEmitTime so panels do not reset visualizations
    const seekAckTimeout = setTimeout(() => {
      this.#presence = PlayerPresence.BUFFERING;
      this.#messages = [];
      this.#currentTime = targetTime;
      this.#queueEmitState();
    }, 100);

    try {
      this.#abort = new AbortController();
      const messages = await this.#bufferedSource.getBackfillMessages({
        topics: this.#allTopics,
        time: targetTime,
        abortSignal: this.#abort.signal,
      });

      // We've successfully loaded the messages and will emit those, no longer need the ackTimeout
      clearTimeout(seekAckTimeout);

      if (this.#nextState) {
        return;
      }

      this.#messages = messages;
      this.#currentTime = targetTime;
      this.#lastSeekEmitTime = Date.now();
      this.#presence = PlayerPresence.PRESENT;
      this.#queueEmitState();
      await this.#resetPlaybackIterator();
      this.#setState(this.#isPlaying ? "play" : "idle");
    } catch (err) {
      if (this.#nextState && err.name === "AbortError") {
        log.debug("Aborted backfill");
      } else {
        throw err;
      }
    } finally {
      // Unless the next state is a seek backfill, we clear the seek target since we have finished seeking
      if (this.#nextState !== "seek-backfill") {
        this.#seekTarget = undefined;
      }
      clearTimeout(seekAckTimeout);
      this.#abort = undefined;
    }
  }

  /** 向注册的侦听器发出播放器状态 */
  async #emitStateImpl() {
    console.log("emitStateImpl--->#queueEmitState");

    if (!this.#listener) {
      return;
    }

    if (this.#hasError) {
      await this.#listener({
        name: this.#name,
        presence: PlayerPresence.ERROR,
        progress: {},
        capabilities: this.#capabilities,
        profile: this.#profile,
        playerId: this.#id,
        activeData: undefined,
        problems: this.#problemManager.problems(), // new PlayerProblemManager();
        urlState: {
          sourceId: this.#sourceId, // 来自外层的初始化，class里面没做处理
          parameters: this.#urlParams, // 来自外层的初始化，class里面没做处理
        },
      });
      return;
    }

    const messages = this.#messages;

    // After we emit the messages we clear the outgoing message array so we do not emit the messages again
    // Use a stable EMPTY_ARRAY so we don't keep emitting a new messages reference as if messages have changed
    this.#messages = EMPTY_ARRAY;

    let activeData: PlayerStateActiveData | undefined;
    if (this.#start && this.#end && this.#currentTime) {
      activeData = {
        messages,
        totalBytesReceived: this.#receivedBytes,
        currentTime: this.#currentTime,
        startTime: this.#start,
        endTime: this.#end,
        isPlaying: this.#isPlaying,
        speed: this.#speed,
        lastSeekTime: this.#lastSeekEmitTime,
        topics: this.#providerTopics,
        topicStats: this.#providerTopicStats,
        datatypes: this.#providerDatatypes,
        publishedTopics: this.#publishedTopics,
      };
    }
    // 下面数据关键一个是  progress ，一个是 activeData
    const data: PlayerState = {
      name: this.#name,
      presence: this.#presence,
      progress: this.#progress, // 进度指示 重要
      capabilities: this.#capabilities, // string[] 放了个字符串数组固定的，暂时感觉不关键
      profile: this.#profile, // 外部文件传过来的，对本class来说 不重要
      playerId: this.#id, // uuid 生成的 不用管
      problems: this.#problemManager.problems(), // new PlayerProblemManager();
      activeData, // 放了一大堆的数据，比如时间，速度等等
      urlState: {
        sourceId: this.#sourceId, // 来自外层的初始化，class里面没做处理
        parameters: this.#urlParams, // 来自外层的初始化，class里面没做处理
      },
    };
    console.log("emitStateImpl----->listener");

    await this.#listener(data);
  }

  /**
   * 通过从消息迭代器读取“tick”值的消息来运行一个tick循环。
   * 记号
   * 这个是视频播放的 关键
   * */
  async #tick(): Promise<void> {
    console.log("tick---->");

    if (!this.#isPlaying) {
      return;
    }
    if (!this.#start || !this.#end) {
      throw new Error("Invariant: start & end should be set before tick()");
    }

    // 考虑到我们想阅读的时间范围有多长
    // the time since our last read and how fast we're currently playing back
    const tickTime = performance.now();
    const durationMillis =
      this.#lastTickMillis != undefined && this.#lastTickMillis !== 0
        ? tickTime - this.#lastTickMillis
        : 20;
    this.#lastTickMillis = tickTime;

    // 最多读取300毫秒的消息，否则如果渲染，事情可能会失控
    // is very slow. Also, smooth over the range that we request, so that a single slow frame won't
    // cause the next frame to also be unnecessarily slow by increasing the frame size.
    let rangeMillis = Math.min(durationMillis * this.#speed, 300);
    if (this.#lastRangeMillis != undefined) {
      console.log("lastRangeMillis", this.#lastRangeMillis);

      rangeMillis = this.#lastRangeMillis * 0.9 + rangeMillis * 0.1;
    }
    this.#lastRangeMillis = rangeMillis;

    if (!this.#currentTime) {
      throw new Error("Invariant: Tried to play with no current time.");
    }

    // 我们想要停止阅读消息并发出勾号状态的结束时间
    // The end time is inclusive.
    const targetTime = add(this.#currentTime, fromMillis(rangeMillis));
    const end: Time = clampTime(targetTime, this.#start, this.#untilTime ?? this.#end);

    // 如果上一次勾选中有lastStamp可用，我们会将该戳与当前戳进行核对
    //tick的结束时间。如果这个印记在我们当前刻度的结束时间之后，那么我们不需要
    //阅读任何消息，并可以快捷方式设置逻辑的其余部分，以将当前时间设置为刻度
    //结束时间并对发射进行排队。
    //
    // 如果我们有lastStamp，但它不在刻度结束之后，那么我们将清除它并继续 勾选逻辑。
    if (this.#lastStamp) {
      console.log("lastStamp");

      if (compare(this.#lastStamp, end) >= 0) {
        console.log("lastStampcompare");

        // Wait for the previous render frame to finish
        await this.#queueEmitState.currentPromise;

        this.#currentTime = end;
        this.#messages = [];
        this.#queueEmitState();

        if (this.#untilTime && compare(this.#currentTime, this.#untilTime) >= 0) {
          console.log("untilTime");

          this.pausePlayback();
        }
        return;
      }

      this.#lastStamp = undefined;
    }

    const msgEvents: MessageEvent[] = [];

    //在结束上一次勾选时，我们可能已经从迭代器中读取了一条消息
    //属于我们的蜱虫。此逻辑将该消息带入我们当前的一批消息事件中。
    if (this.#lastMessageEvent) {
      console.log("lastMessageEvent");

      // If the last message we saw is still ahead of the tick end time, we don't emit anything
      if (compare(this.#lastMessageEvent.receiveTime, end) > 0) {
        console.log("comparelastMessageEvent");

        // Wait for the previous render frame to finish
        await this.#queueEmitState.currentPromise;

        this.#currentTime = end;
        this.#messages = msgEvents;
        this.#queueEmitState();

        if (this.#untilTime && compare(this.#currentTime, this.#untilTime) >= 0) {
          this.pausePlayback();
        }
        return;
      }

      msgEvents.push(this.#lastMessageEvent);
      this.#lastMessageEvent = undefined;
    }

    // 如果我们花太长时间读取刻度数据，我们会将玩家设置为缓冲状态。这
    // 表示玩家正在等待加载更多数据。当滴答声终于结束时，我们
    //清除此超时。
    const tickTimeout = setTimeout(() => {
      console.log("tickTimeout");

      this.#presence = PlayerPresence.BUFFERING;
      this.#queueEmitState();
    }, 500);

    try {
      // 从迭代器读取到刻度时间结束
      for (;;) {
        if (!this.#playbackIterator) {
          throw new Error("Invariant. this._playbackIterator is undefined.");
        }
        console.log("for");

        const result = await this.#playbackIterator.next();
        if (result.done === true || this.#nextState) {
          break;
        }
        const iterResult = result.value;

        if (iterResult.type === "problem") {
          console.log("problem");

          this.#problemManager.addProblem(`connid-${iterResult.connectionId}`, iterResult.problem);
          continue;
        }

        if (iterResult.type === "stamp" && compare(iterResult.stamp, end) >= 0) {
          console.log("stamp");

          this.#lastStamp = iterResult.stamp;
          break;
        }

        if (iterResult.type === "message-event") {
          console.log("message-event");

          // The message is past the tick end time, we need to save it for next tick
          if (compare(iterResult.msgEvent.receiveTime, end) > 0) {
            console.log("message-eventcompare");

            this.#lastMessageEvent = iterResult.msgEvent;
            break;
          }
          console.log("message-eventpush");

          msgEvents.push(iterResult.msgEvent);
        }
      }
    } finally {
      clearTimeout(tickTimeout);
    }

    // Set the presence back to PRESENT since we are no longer buffering
    this.#presence = PlayerPresence.PRESENT;

    if (this.#nextState) {
      return;
    }

    // 等待任何激活的发射状态作为此记号的一部分完成
    //如果不等待发射状态完成，我们可能会丢弃消息，因为我们的发射状态
    //可能会被开除
    await this.#queueEmitState.currentPromise;

    this.#currentTime = end;
    this.#messages = msgEvents;
    console.log("触发 #queueEmitState");

    this.#queueEmitState();

    // 他的滴答声已经到了untilTime的末尾，所以我们回去暂停
    if (this.#untilTime && compare(this.#currentTime, this.#untilTime) >= 0) {
      console.log("untilTime");

      // 暂停播放
      this.pausePlayback();
    }
    console.log("结束tick enddddd");
  } // 结束
  // 触发 ‘idle’ 后 触发下面函数，作用是中止播放
  async #stateIdle() {
    console.log("触发IDLE");

    assert(this.#abort == undefined, "Invariant: some other abort controller exists");

    this.#isPlaying = false;
    this.#presence = PlayerPresence.PRESENT;

    // 为下一个发射状态设置加载范围的最新值
    this.#progress = {
      ...this.#progress,
      fullyLoadedFractionRanges: this.#bufferedSource.loadedRanges(),
      messageCache: this.#progress.messageCache,
    };
    //  AbortController 接口表示一个控制器对象，允许你根据需要中止一个或多个 Web 请求。
    const abort = (this.#abort = new AbortController());
    const aborted = new Promise((resolve) => {
      abort.signal.addEventListener("abort", resolve);
    });

    const rangeChangeHandler = () => {
      this.#progress = {
        fullyLoadedFractionRanges: this.#bufferedSource.loadedRanges(),
        messageCache: this.#progress.messageCache,
        memoryInfo: {
          ...this.#progress.memoryInfo,
          [MEMORY_INFO_BUFFERED_MSGS]: this.#bufferedSource.getCacheSize(),
        },
      };
      this.#queueEmitState();
    };

    // While idle, the buffered source might still be loading and we still want to update downstream
    // with the new ranges we've buffered. This event will update progress and queue state emits
    this.#bufferedSource.on("loadedRangesChange", rangeChangeHandler);

    this.#queueEmitState();
    await aborted;
    this.#bufferedSource.off("loadedRangesChange", rangeChangeHandler);
  } // end
  // 触发 ‘play’ 后，执行下面函数
  async #statePlay() {
    console.log("statePlay---->");

    this.#presence = PlayerPresence.PRESENT;

    if (!this.#currentTime) {
      throw new Error("Invariant: currentTime not set before statePlay");
    }
    if (!this.#start || !this.#end) {
      throw new Error("Invariant: start & end should be set before statePlay");
    }

    // Track the identity of allTopics, if this changes we need to reset our iterator to
    // get new messages for new topics
    const allTopics = this.#allTopics;

    try {
      // 不断地视频 这个while才是不断地模拟视频进度条的关键所在
      // 点击暂停后 this.#nextState就有值了，所以while就不成立了，所以while结束
      while (this.#isPlaying && !this.#hasError && !this.#nextState) {
        console.log("statePlay: tick");

        if (compare(this.#currentTime, this.#end) >= 0) {
          console.log("statePlay: playback has ended");

          // 播放已结束。重置内部跟踪器以保持播放速度
          this.#lastTickMillis = undefined;
          this.#lastRangeMillis = undefined;
          this.#lastStamp = undefined;
          this.#setState("idle");
          return;
        }

        const start = Date.now();
        // 关键
        await this.#tick();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/strict-boolean-expressions
        if (this.#nextState) {
          return;
        }

        // 使用缓冲源中最新加载的范围进行更新
        // messageCache由块加载程序事件单独更新
        this.#progress = {
          // fullyLoadedFractionRanges 这个才是最最关键，指示加载的范围
          fullyLoadedFractionRanges: this.#bufferedSource.loadedRanges(),
          messageCache: this.#progress.messageCache,
          memoryInfo: {
            ...this.#progress.memoryInfo,
            [MEMORY_INFO_BUFFERED_MSGS]: this.#bufferedSource.getCacheSize(),
          },
        };

        // 如果订阅已更改，请更新到新订阅
        if (this.#allTopics !== allTopics) {
          console.log("allTopics changed");
          // Discard any last message event since the new iterator will repeat it
          this.#lastMessageEvent = undefined;

          // 当主题发生变化时，暂停播放并重置播放迭代器，以便我们可以加载
          // the new topics
          this.#setState("reset-playback-iterator");
          return;
        }

        const time = Date.now() - start;
        // 确保我们至少睡了16毫秒左右（大约1帧）
        //给UI一些呼吸的时间，而不是在紧张的循环中燃烧
        if (time < 16) {
          console.log("time < 16");
          await delay(16 - time);
        }
      }
      console.log("while 结束");
    } catch (err) {
      this.#setError((err as Error).message, err);
      this.#queueEmitState();
    }
  }

  async #stateClose() {
    console.log("stateClose--->");

    this.#isPlaying = false;
    this.#metricsCollector.close();
    await this.#blockLoader?.stopLoading();
    await this.#blockLoadingProcess;
    await this.#bufferedSource.stopProducer();
    await this.#bufferedSource.terminate();
    await this.#playbackIterator?.return?.();
    this.#playbackIterator = undefined;
    await this.#iterableSource.terminate?.();
    this.#resolveIsClosed();
  }

  async #startBlockLoading() {
    console.log("statePlay: startBlockLoading--->");

    await this.#blockLoader?.startLoading({
      progress: async (progress) => {
        this.#progress = {
          fullyLoadedFractionRanges: this.#progress.fullyLoadedFractionRanges,
          messageCache: progress.messageCache,
          memoryInfo: {
            ...this.#progress.memoryInfo,
            ...progress.memoryInfo,
          },
        };
        // If we are in playback, we will let playback queue state updates
        if (this.#state === "play") {
          return;
        }

        this.#queueEmitState();
      },
    });
  }
}
