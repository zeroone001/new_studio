// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ComponentType, createContext, useContext } from "react";

import { PanelStatics } from "@foxglove/studio-base/components/Panel";
import { ExtensionNamespace } from "@foxglove/studio-base/types/Extensions";
import { PanelConfig } from "@foxglove/studio-base/types/panels";

export type PanelComponent = ComponentType<{ childId?: string; tabId?: string }> &
  PanelStatics<PanelConfig>;

export type PanelInfo = {
  title: string;
  type: string;
  description?: string;
  thumbnail?: string;
  help?: React.ReactNode;

  /** Set this to true if a panel has custom toolbar items and so cannot be renamed. */
  hasCustomToolbar?: boolean;

  /**
   * The panel module is a function to load the panel.
   * This is to support our lazy built-in panels
   */
  module: () => Promise<{ default: PanelComponent }>;
  config?: PanelConfig;
  extensionNamespace?: ExtensionNamespace;
};

/** PanelCatalog描述了获取可用面板的界面 */
export interface PanelCatalog {
  /** 获取可用面板的列表 */
  getPanels(): readonly PanelInfo[];

  /** 获取特定面板类型的面板信息（即3d、地图、图像等） */
  getPanelByType(type: string): PanelInfo | undefined;
}

const PanelCatalogContext = createContext<PanelCatalog | undefined>(undefined);
PanelCatalogContext.displayName = "PanelCatalogContext";

export function usePanelCatalog(): PanelCatalog {
  const panelCatalog = useContext(PanelCatalogContext);
  if (!panelCatalog) {
    throw new Error("A PanelCatalogContext provider is required to usePanelCatalog");
  }

  return panelCatalog;
}

export default PanelCatalogContext;
