// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";

import { useCrash } from "@foxglove/hooks";
import { PanelExtensionContext } from "@foxglove/studio";
import { CaptureErrorBoundary } from "@foxglove/studio-base/components/CaptureErrorBoundary";
import Panel from "@foxglove/studio-base/components/Panel";
import { PanelExtensionAdapter } from "@foxglove/studio-base/components/PanelExtensionAdapter";
import ThemeProvider from "@foxglove/studio-base/theme/ThemeProvider";
import { SaveConfig } from "@foxglove/studio-base/types/panels";

import { Indicator } from "./Indicator";
import { Config } from "./types";

function initPanel(crash: ReturnType<typeof useCrash>, context: PanelExtensionContext) {
  const root = createRoot(context.panelElement);
  root.render(
    <StrictMode>
      <CaptureErrorBoundary onError={crash}>
        <ThemeProvider isDark>
          <Indicator context={context} />
        </ThemeProvider>
      </CaptureErrorBoundary>
    </StrictMode>,
  );
  // ReactDOM.render(
  //   <StrictMode>
  //     <CaptureErrorBoundary onError={crash}>
  //       <ThemeProvider isDark>
  //         <Indicator context={context} />
  //       </ThemeProvider>
  //     </CaptureErrorBoundary>
  //   </StrictMode>,
  //   context.panelElement,
  // );
  return () => {
    // ReactDOM.unmountComponentAtNode(context.panelElement);
    setTimeout(() => {
      root.unmount();
    }, 0);
  };
}

type Props = {
  config: Config;
  saveConfig: SaveConfig<Config>;
};

function IndicatorLightPanelAdapter(props: Props) {
  const crash = useCrash();
  const boundInitPanel = useMemo(() => initPanel.bind(undefined, crash), [crash]);

  return (
    <PanelExtensionAdapter
      config={props.config}
      saveConfig={props.saveConfig}
      initPanel={boundInitPanel}
      highestSupportedConfigVersion={1}
    />
  );
}

IndicatorLightPanelAdapter.panelType = "Indicator";
IndicatorLightPanelAdapter.defaultConfig = {};

export default Panel(IndicatorLightPanelAdapter);
