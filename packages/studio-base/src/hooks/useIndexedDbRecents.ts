// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
// 这是一个使用 IndexedDB 实现的超级简单的基于 Promise 的键值存储
import { set as idbSet, get as idbGet, createStore as idbCreateStore } from "idb-keyval";
import * as _ from "lodash-es";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAsync } from "react-use";
import { v4 as uuid } from "uuid";

import Logger from "@foxglove/log";

const log = Logger.getLogger(__filename);

const IDB_KEY = "recents";
// 自定义数据库名foxglove-recents 和 store名recents
// https://github.com/jakearchibald/idb-keyval/blob/main/custom-stores.md
const IDB_STORE = idbCreateStore("foxglove-recents", "recents");

type RecentRecordCommon = {
  // Record id - use IndexedDbRecentsStore.GenerateRecordId() to generate
  id: string;

  // The source id
  sourceId: string;

  // The primary text for the recent record
  title: string;

  // Optional label for the recent record
  label?: string;
};

type RecentConnectionRecord = RecentRecordCommon & {
  type: "connection";
  // Optional arguments stored with the recent entry
  extra?: Record<string, string | undefined>;
};

type RecentFileRecord = RecentRecordCommon & {
  type: "file";
  handle: FileSystemFileHandle; // foxglove-depcheck-used: @types/wicg-file-system-access
};

type UnsavedRecentRecord = Omit<RecentConnectionRecord, "id"> | Omit<RecentFileRecord, "id">;

export type RecentRecord = RecentConnectionRecord | RecentFileRecord;

interface IRecentsStore {
  // Recent records
  recents: RecentRecord[];

  // Add a new recent
  addRecent: (newRecent: UnsavedRecentRecord) => void;

  // Save changes
  save: () => Promise<void>;
}

function useIndexedDbRecents(): IRecentsStore {
  const { value: initialRecents, loading } = useAsync(
    async () => await idbGet<RecentRecord[] | undefined>(IDB_KEY, IDB_STORE),
    [],
  );

  const [recents, setRecents] = useState<RecentRecord[]>([]);

  // 跟踪ref中的新recent，并在持久化后更新状态
  const newRecentsRef = useRef<RecentRecord[]>([]);
  // 保存
  const save = useCallback(async () => {
    // 在加载现有的recent之前，我们不会进行保存。这样可以确保我们在保存时包含已存储的最近值
    if (loading) {
      return;
    }

    // 新的最近出现在列表的开头
    const recentsToSave: RecentRecord[] = [];

    // 对于newRecentsRef中的每个ref，我们需要消除中已经存在的任何潜在重复项
    // 最近保存
    for (const newRecent of newRecentsRef.current) {
      let exists = false;
      for (const savedRecent of recentsToSave) {
        if (exists) {
          continue;
        }

        // 筛选文件最近的内容以忽略与此记录匹配的任何以前的最近的内容。
        //如果我们想将文件添加到已有的recents中，就会发生这种情况
        if (
          savedRecent.type === "file" &&
          newRecent.type === savedRecent.type &&
          (await savedRecent.handle.isSameEntry(newRecent.handle))
        ) {
          exists = true;
        }

        // 筛选匹配相同sourceId和额外args的连接recent
        if (
          savedRecent.type === "connection" &&
          newRecent.type === savedRecent.type &&
          savedRecent.sourceId === newRecent.sourceId &&
          _.isEqual(newRecent.extra, savedRecent.extra)
        ) {
          exists = true;
        }
      }

      // Max 5 entries
      if (!exists && recentsToSave.length < 5) {
        recentsToSave.push(newRecent);
      }
    }

    setRecents(recentsToSave);
    // 这里保存， 使用IndexedDB，整个文件，主要就是干了这么一件事
    idbSet(IDB_KEY, recentsToSave, IDB_STORE).catch((err) => {
      log.error(err);
    });
  }, [loading]);

  // 将存储中的第一个加载记录设置为状态
  useLayoutEffect(() => {
    if (loading) {
      return;
    }

    const haveUnsavedRecents = newRecentsRef.current.length > 0;

    if (initialRecents) {
      newRecentsRef.current.push(...initialRecents);
    }

    if (haveUnsavedRecents) {
      void save();
    } else {
      // 加载初始最近项时没有新的最近项，因此不需要保存
      // 通常情况下，保存会调用set，但由于我们不需要保存，因此在此处设置
      setRecents(newRecentsRef.current);
    }
  }, [loading, initialRecents, save]);

  const addRecent = useCallback(
    (record: UnsavedRecentRecord) => {
      const fullRecord: RecentRecord = {
        id: uuid(),
        ...record,
      };
      newRecentsRef.current.unshift(fullRecord);
      // 保存
      void save();
    },
    [save],
  );

  return useMemo<IRecentsStore>(() => {
    return {
      recents,
      addRecent,
      save,
    };
  }, [addRecent, recents, save]);
}

export default useIndexedDbRecents;
