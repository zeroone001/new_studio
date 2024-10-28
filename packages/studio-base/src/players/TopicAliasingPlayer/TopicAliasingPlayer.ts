// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";

import { MutexLocked } from "@foxglove/den/async";
import { Time } from "@foxglove/rostime";
import { Immutable, ParameterValue } from "@foxglove/studio";
import { Asset } from "@foxglove/studio-base/components/PanelExtensionAdapter";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import {
  AdvertiseOptions,
  Player,
  PlayerState,
  PublishPayload,
  SubscribePayload,
} from "@foxglove/studio-base/players/types";

import { IStateProcessor } from "./IStateProcessor";
import { NoopStateProcessor } from "./NoopStateProcessor";
import {
  StateFactoryInput,
  StateProcessorFactory,
  TopicAliasFunctions,
} from "./StateProcessorFactory";

export type { TopicAliasFunctions };

/**
 * 这是一个包装底层播放器并将别名应用于所有主题名称的播放器
 * 在从播放器发出的数据中。
 *
 * 将输入主题别名为其他输入主题或请求冲突的别名
 * 不允许并标记从多个输入主题到同一输出主题的别名
 * 作为玩家的问题
 */
export class TopicAliasingPlayer implements Player {
  readonly #player: Player;

  #inputs: Immutable<StateFactoryInput>;
  #aliasedSubscriptions: undefined | SubscribePayload[];
  #subscriptions: SubscribePayload[] = [];

  // True if no aliases are active and we can pass calls directly through to the
  // underlying player.
  #skipAliasing: boolean;

  #stateProcessorFactory: StateProcessorFactory = new StateProcessorFactory();
  #stateProcessor: IStateProcessor = new NoopStateProcessor();

  #lastPlayerState?: PlayerState;

  // We only want to be emitting one state at a time however we also queue emits from global
  // variable updates which can happen at a different time to new state from the wrapped player. The
  // mutex prevents invoking the listener concurrently.
  #listener?: MutexLocked<(state: PlayerState) => Promise<void>>;
  // 这个class 其实没啥东西，关键是对IterablePlayer.ts的又又封了一层
  // 关键函数，就一个#onPlayerState
  public constructor(player: Player) {
    // #player 就是 IterablePlayer.ts
    this.#player = player;
    this.#skipAliasing = true;
    this.#inputs = {
      aliasFunctions: [],
      topics: undefined,
      variables: {},
    };
  }

  public setListener(listener: (playerState: PlayerState) => Promise<void>): void {
    console.log("TopicAliasingPlayer.setListener");

    this.#listener = new MutexLocked(listener);

    this.#player.setListener(async (state) => {
      await this.#onPlayerState(state);
    });
  }

  public setAliasFunctions(aliasFunctions: Immutable<TopicAliasFunctions>): void {
    this.#inputs = { ...this.#inputs, aliasFunctions };
    this.#skipAliasing = aliasFunctions.length === 0;
  }

  public close(): void {
    this.#player.close();
  }

  public setSubscriptions(subscriptions: SubscribePayload[]): void {
    this.#subscriptions = subscriptions;
    this.#aliasedSubscriptions = this.#stateProcessor.aliasSubscriptions(subscriptions);
    this.#player.setSubscriptions(this.#aliasedSubscriptions);
  }

  public setPublishers(publishers: AdvertiseOptions[]): void {
    this.#player.setPublishers(publishers);
  }

  public setParameter(key: string, value: ParameterValue): void {
    this.#player.setParameter(key, value);
  }

  public publish(request: PublishPayload): void {
    this.#player.publish(request);
  }

  public async callService(service: string, request: unknown): Promise<unknown> {
    return await this.#player.callService(service, request);
  }

  public startPlayback?(): void {
    console.log("startPlayback1");
    this.#player.startPlayback?.();
  }

  public pausePlayback?(): void {
    this.#player.pausePlayback?.();
  }

  public seekPlayback?(time: Time): void {
    this.#player.seekPlayback?.(time);
  }

  public playUntil?(time: Time): void {
    if (this.#player.playUntil) {
      this.#player.playUntil(time);
      return;
    }
    this.#player.seekPlayback?.(time);
  }

  public setPlaybackSpeed?(speedFraction: number): void {
    this.#player.setPlaybackSpeed?.(speedFraction);
  }

  public setGlobalVariables(globalVariables: GlobalVariables): void {
    this.#player.setGlobalVariables(globalVariables);

    // Set this before the lastPlayerstate skip below so we have global variables when
    // a player state is provided later.
    this.#inputs = { ...this.#inputs, variables: globalVariables };

    // We can skip re-processing if we don't have any alias functions setup or we have not
    // had any player state provided yet. The player state handler onPlayerState will handle alias
    // function processing when it is called.
    if (
      this.#skipAliasing ||
      this.#lastPlayerState == undefined ||
      this.#inputs.topics == undefined
    ) {
      return;
    }

    const stateProcessor = this.#stateProcessorFactory.buildStateProcessor(this.#inputs);

    // If we have a new state processor, it means something about the aliases has changed and we
    // need to re-process the existing player state
    const shouldReprocess = stateProcessor !== this.#stateProcessor;
    this.#stateProcessor = stateProcessor;

    // If we have a new processor we might also have new subscriptions for downstream
    if (shouldReprocess) {
      this.#resetSubscriptions();
    }

    // Re-process the last player state if the processor has changed since we might have new downstream topics
    // for panels to subscribe or get new re-mapped messages.
    //
    // Skip this if we are playing and allow the next player state update to handle this to avoid
    // these emits interfering with player state updates. It does assume the player is emitting
    // state relatively quickly when playing so the new aliases are injected. If this assumption
    // changes this bail might need revisiting.
    if (shouldReprocess && this.#lastPlayerState.activeData?.isPlaying === false) {
      void this.#onPlayerState(this.#lastPlayerState);
    }
  }

  public async fetchAsset(uri: string): Promise<Asset> {
    if (this.#player.fetchAsset) {
      return await this.#player.fetchAsset(uri);
    }
    throw Error("Player does not support fetching assets");
  }

  async #onPlayerState(playerState: PlayerState) {
    // playerState 就是上层IterablePlayer传回来的data
    console.log("onPlayerState--->", playerState);

    // 如果我们已经在发射一个玩家状态，请避免发射另一个状态
    //这是对全局变量排放的防范
    if (this.#listener?.isLocked() === true) {
      return;
    }

    return await this.#listener?.runExclusive(async (listener) => {
      console.log("onPlayerState2", listener);

      if (this.#skipAliasing) {
        await listener(playerState);
        return;
      }

      // 玩家主题已经更改，因此我们需要重新构建别名，因为玩家主题
      // 是别名函数的输入。
      if (playerState.activeData?.topics !== this.#inputs.topics) {
        console.log("topics changed");

        this.#inputs = { ...this.#inputs, topics: playerState.activeData?.topics };
        const stateProcessor = this.#stateProcessorFactory.buildStateProcessor(this.#inputs);

        // 如果状态处理器发生了更改，那么我们可能需要重新处理订阅，因为
        // 我们现在可能能够生成新的订阅
        if (this.#stateProcessor !== stateProcessor) {
          console.log("state processor changed");

          this.#stateProcessor = stateProcessor;
          this.#resetSubscriptions();
        }
      }

      // 记住最后一个玩家状态，这样我们就可以在设置全局变量时重用它
      this.#lastPlayerState = playerState;

      // 使用最新别名处理玩家状态
      const newState = this.#stateProcessor.process(playerState, this.#subscriptions);

      await listener(newState);
    });
  }

  /**
   * Re-calculate the subscriptions using the latest state processor. If the subscriptions have
   * changed then call setSubscriptions on the wrapped player.
   */
  #resetSubscriptions() {
    const aliasedSubscriptions = this.#stateProcessor.aliasSubscriptions(this.#subscriptions);
    if (!_.isEqual(this.#aliasedSubscriptions, aliasedSubscriptions)) {
      this.#aliasedSubscriptions = aliasedSubscriptions;
      this.#player.setSubscriptions(aliasedSubscriptions);
    }
  }
}
