// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { StoreApi, useStore } from "zustand";

import { useGuaranteedContext } from "@foxglove/hooks";
import { Immutable } from "@foxglove/studio";
import { AppSetting } from "@foxglove/studio-base/AppSetting";
import CurrentLayoutContext, {
  LayoutState,
} from "@foxglove/studio-base/context/CurrentLayoutContext";
import { useAppConfigurationValue } from "@foxglove/studio-base/hooks/useAppConfigurationValue";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import {
  Player,
  PlayerProblem,
  PlayerState,
  SubscribePayload,
} from "@foxglove/studio-base/players/types";

import MessageOrderTracker from "./MessageOrderTracker";
import { pauseFrameForPromises, FramePromise } from "./pauseFrameForPromise";
import {
  MessagePipelineInternalState,
  createMessagePipelineStore,
  defaultPlayerState,
} from "./store";
import { MessagePipelineContext } from "./types";

export type { MessagePipelineContext };

const EMPTY_GLOBAL_VARIABLES: GlobalVariables = Object.freeze({});

// exported only for MockMessagePipelineProvider
export const ContextInternal = createContext<StoreApi<MessagePipelineInternalState> | undefined>(
  undefined,
);

/**
 * useMessagePipelineGetter returns a function to access the current message pipeline context.
 * Commonly used in places where you want to access a value from the latest pipeline in a useCallback hook
 * but don't want the callback dependencies invalidated on ever change.
 *
 * @returns a function to return the current MessagePipelineContext
 */
export function useMessagePipelineGetter(): () => MessagePipelineContext {
  const store = useGuaranteedContext(ContextInternal);
  return useCallback(() => store.getState().public, [store]);
}

export function useMessagePipeline<T>(selector: (arg0: MessagePipelineContext) => T): T {
  const store = useGuaranteedContext(ContextInternal);
  return useStore(
    store,
    useCallback((state) => selector(state.public), [selector]),
  );
}

export function useMessagePipelineSubscribe(): (
  fn: (state: MessagePipelineContext) => void,
) => () => void {
  const store = useGuaranteedContext(ContextInternal);

  return useCallback(
    (fn: (state: MessagePipelineContext) => void) => {
      return store.subscribe((state) => {
        fn(state.public);
      });
    },
    [store],
  );
}

type ProviderProps = {
  children: React.ReactNode;

  // Represents either the lack of a player, a player that is currently being constructed, or a
  // valid player. MessagePipelineProvider is not responsible for building players, but it is
  // responsible for providing player state information downstream in a context -- so this
  // information is passed in and merged with other player state.
  player?: Player;
};

const selectRenderDone = (state: MessagePipelineInternalState) => state.renderDone;
const selectSubscriptions = (state: MessagePipelineInternalState) => state.public.subscriptions;

export function MessagePipelineProvider({ children, player }: ProviderProps): React.ReactElement {
  const promisesToWaitForRef = useRef<FramePromise[]>([]);

  // We make a new store when the player changes. This throws away any state from the previous store
  // and re-creates the pipeline functions and references. We make a new store to avoid holding onto
  // any state from the previous store.
  //
  // Note: This throws away any publishers, subscribers, etc that panels may have registered. We
  // are ok with this behavior because the <Workspace> re-mounts all panels when a player changes.
  // The re-mounted panels will re-initialize and setup new publishers and subscribers.
  const store = useMemo(() => {
    return createMessagePipelineStore({ promisesToWaitForRef, initialPlayer: player });
  }, [player]);

  const subscriptions = useStore(store, selectSubscriptions);

  // Debounce the subscription updates for players. This batches multiple subscribe calls
  // into one update for the player which avoids fetching data that will be immediately discarded.
  //
  // The delay of 0ms is intentional as we only want to give one timeout cycle to batch updates
  const debouncedPlayerSetSubscriptions = useMemo(() => {
    return _.debounce((subs: Immutable<SubscribePayload[]>) => {
      player?.setSubscriptions(subs);
    });
  }, [player]);

  // when unmounting or changing the debounce function cancel any pending debounce
  useEffect(() => {
    return () => {
      debouncedPlayerSetSubscriptions.cancel();
    };
  }, [debouncedPlayerSetSubscriptions]);

  useEffect(
    () => debouncedPlayerSetSubscriptions(subscriptions),
    [debouncedPlayerSetSubscriptions, subscriptions],
  );

  // Slow down the message pipeline framerate to the given FPS if it is set to less than 60
  const [messageRate] = useAppConfigurationValue<number>(AppSetting.MESSAGE_RATE);

  // Tell listener the layout has completed
  const renderDone = useStore(store, selectRenderDone);
  useLayoutEffect(() => {
    renderDone?.();
  }, [renderDone]);

  const msPerFrameRef = useRef<number>(16);
  msPerFrameRef.current = 1000 / (messageRate ?? 60);

  // To avoid re-rendering the MessagePipelineProvider and all children when global variables change
  // we register a listener directly on the context to track updates to global variables.
  //
  // We don't need to re-render because there's no react state update in our component that needs
  // to render with this update.
  const currentLayoutContext = useContext(CurrentLayoutContext);

  useEffect(() => {
    // Track the last global variables we've received in the layout selector so we can avoid setting
    // the variables on a player unless they have changed because we don't want to tell a player about
    // new variables when there aren't any and make it potentially do work.
    let lastGlobalVariablesInstance: GlobalVariables | undefined =
      currentLayoutContext?.actions.getCurrentLayoutState().selectedLayout?.data?.globalVariables ??
      EMPTY_GLOBAL_VARIABLES;

    player?.setGlobalVariables(lastGlobalVariablesInstance);

    const onLayoutStateUpdate = (state: LayoutState) => {
      const globalVariables = state.selectedLayout?.data?.globalVariables ?? EMPTY_GLOBAL_VARIABLES;
      if (globalVariables !== lastGlobalVariablesInstance) {
        lastGlobalVariablesInstance = globalVariables;
        player?.setGlobalVariables(globalVariables);
      }
    };

    currentLayoutContext?.addLayoutStateListener(onLayoutStateUpdate);
    return () => {
      currentLayoutContext?.removeLayoutStateListener(onLayoutStateUpdate);
    };
  }, [currentLayoutContext, player]);

  useEffect(() => {
    const dispatch = store.getState().dispatch;
    if (!player) {
      // 当没有玩家时，将玩家状态设置为默认状态以返回到我们
      // indicate the player is not present.
      dispatch({
        type: "update-player-state",
        playerState: defaultPlayerState(),
        renderDone: undefined,
      });
      return;
    }

    const { listener, cleanupListener } = createPlayerListener({
      msPerFrameRef,
      promisesToWaitForRef,
      store,
    });
    player.setListener(listener);
    return () => {
      cleanupListener();
      player.close();
      dispatch({
        type: "update-player-state",
        playerState: defaultPlayerState(),
        renderDone: undefined,
      });
    };
  }, [player, store]);

  return <ContextInternal.Provider value={store}>{children}</ContextInternal.Provider>;
}

// Given a PlayerState and a PlayerProblem array, add the problems to any existing player problems
function concatProblems(origState: PlayerState, problems: PlayerProblem[]): PlayerState {
  if (problems.length === 0) {
    return origState;
  }

  return {
    ...origState,
    problems: problems.concat(origState.problems ?? []),
  };
}

/**
 * 播放器侦听器的创建被提取为一个单独的函数，以防止内存泄漏。
 *当在一个外部函数内部创建多个闭包时，V8会分配一个“上下文”对象
 *由所有内部闭包共享，保存它们访问的共享变量。只要有
 *的内部闭包仍然有效，上下文和**所有**共享变量仍然有效。
 *
 * 在MessagePipelineProvider的情况下，当“listener”闭包直接在内部创建时
 *使用上面的效果，它最终会保留一个共享的上下文，同时也保留了玩家
 *“usePlayerState（）”返回的“state”变量，即使侦听器闭包实际上没有
 *使用它。特别是，每次在useEffect中创建新玩家时，都会导致
 *保留老玩家的状态（通过监听器关闭），创建一个“链表”效果
 *导致每个播放器产生的最后一个状态（因此也导致其预加载的消息块）
 *随着新数据源的交换而无限期地保留。
 *
 * 为了避免这个问题，我们将闭包创建提取到模块级函数中
 *不会看到外部作用域中可能保留在共享上下文中的变量，因为
 *它们在其他闭合件中的使用。
 *
 */
function createPlayerListener(args: {
  msPerFrameRef: React.MutableRefObject<number>;
  promisesToWaitForRef: React.MutableRefObject<FramePromise[]>;
  store: StoreApi<MessagePipelineInternalState>;
}): {
  listener: (state: PlayerState) => Promise<void>;
  cleanupListener: () => void;
} {
  const { msPerFrameRef, promisesToWaitForRef, store } = args;
  const updateState = store.getState().dispatch;
  const messageOrderTracker = new MessageOrderTracker();
  let closed = false;
  let prevPlayerId: string | undefined;
  let resolveFn: undefined | (() => void);
  const listener = async (listenerPlayerState: PlayerState) => {
    if (closed) {
      return;
    }

    if (resolveFn) {
      throw new Error("New playerState was emitted before last playerState was rendered.");
    }

    // check for any out-of-order or out-of-sync messages
    const problems = messageOrderTracker.update(listenerPlayerState);
    const newPlayerState = concatProblems(listenerPlayerState, problems);

    const promise = new Promise<void>((resolve) => {
      resolveFn = () => {
        resolveFn = undefined;
        resolve();
      };
    });

    // Track when we start the state update. This will pair when layout effect calls renderDone.
    const start = Date.now();

    // Render done is invoked by a layout effect once the component has rendered.
    // After the component renders, we kick off an animation frame to give panels one
    // animation frame to invoke pause.
    let called = false;
    function renderDone() {
      if (called) {
        return;
      }
      called = true;

      // Compute how much time remains before this frame is done
      const delta = Date.now() - start;
      const frameTime = Math.max(0, msPerFrameRef.current - delta);

      // Panels have the remaining frame time to invoke pause
      setTimeout(async () => {
        if (closed) {
          return;
        }

        const promisesToWaitFor = promisesToWaitForRef.current;
        if (promisesToWaitFor.length > 0) {
          promisesToWaitForRef.current = [];
          await pauseFrameForPromises(promisesToWaitFor);
        }

        if (!resolveFn) {
          return;
        }
        resolveFn();
      }, frameTime);
    }

    if (prevPlayerId != undefined && listenerPlayerState.playerId !== prevPlayerId) {
      store.getState().reset();
    }
    prevPlayerId = listenerPlayerState.playerId;
    // 更新store的state
    updateState({
      type: "update-player-state",
      playerState: newPlayerState, // 关键竟然在这个位置
      renderDone,
    });

    await promise;
  };
  return {
    listener,
    cleanupListener() {
      closed = true;
      resolveFn = undefined;
    },
  };
}
