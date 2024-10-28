// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import EmptyState from "@foxglove/studio-base/components/EmptyState";
import withPanel from "@foxglove/studio-base/components/Panel";
import PanelToolbar from "@foxglove/studio-base/components/PanelToolbar";
import Stack from "@foxglove/studio-base/components/Stack";
import { SaveConfig } from "@foxglove/studio-base/types/panels";

// 由于未知面板从不保存其配置，因此此处的配置字段与`overrideConfig一起使用`
// 连接到已连接的Panel组件（从withPanel返回）。
//
// type _ config选项应该是缺少的面板的类型。
type Props = {
  config: { type: string; id: string };
  saveConfig: SaveConfig<unknown>;
};

function UnconnectedUnknownPanel(props: Props) {
  const { config, saveConfig: _saveConfig } = props;

  return (
    <Stack flex="auto" alignItems="center" justifyContent="center" data-testid={config.id}>
      <PanelToolbar isUnknownPanel />
      <EmptyState>Unknown panel type: {config.type}.</EmptyState>
    </Stack>
  );
}
UnconnectedUnknownPanel.panelType = "unknown";
UnconnectedUnknownPanel.defaultConfig = {};

/**
 * 未知面板代表缺失的面板。当布局中引用的面板不是可用（可能扩展未安装），显示此面板
 */
export const UnknownPanel = withPanel(UnconnectedUnknownPanel);
