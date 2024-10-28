// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PlayerProblem } from "@foxglove/studio-base/players/types";

/**
 * 管理一组由ID键控的PlayerProblems。对problems（）的调用将返回与相同的对象
 *只要问题没有被添加/删除；这有助于玩家管道知道何时
 *需要重新处理玩家的问题。
 */
export default class PlayerProblemManager {
  #problemsById = new Map<string, PlayerProblem>();
  #problems?: PlayerProblem[];

  /**
   * Returns the current set of problems. Subsequent calls will return the same object as long as
   * problems have not been added/removed.
   */
  public problems(): PlayerProblem[] {
    return (this.#problems ??= Array.from(this.#problemsById.values()));
  }

  public addProblem(id: string, problem: PlayerProblem): void {
    console[problem.severity].call(console, "Player problem", id, problem);
    this.#problemsById.set(id, problem);
    this.#problems = undefined;
  }

  public hasProblem(id: string): boolean {
    return this.#problemsById.has(id);
  }

  public removeProblem(id: string): boolean {
    const changed = this.#problemsById.delete(id);
    if (changed) {
      this.#problems = undefined;
    }
    return changed;
  }

  public removeProblems(predicate: (id: string, problem: PlayerProblem) => boolean): boolean {
    let changed = false;
    for (const [id, problem] of this.#problemsById) {
      if (predicate(id, problem)) {
        if (this.#problemsById.delete(id)) {
          changed = true;
        }
      }
    }
    if (changed) {
      this.#problems = undefined;
    }
    return changed;
  }

  public clear(): void {
    this.#problemsById.clear();
    this.#problems = undefined;
  }
}
