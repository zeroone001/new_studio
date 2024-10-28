// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import Logger from "@foxglove/log";
import type { IDataSourceFactory } from "@foxglove/studio-base";
import CssBaseline from "@foxglove/studio-base/components/CssBaseline";

import { CompatibilityBanner } from "./CompatibilityBanner";
import { canRenderApp } from "./canRenderApp";

const log = Logger.getLogger(__filename);

function LogAfterRender(props) {
  useEffect(() => {
    // 集成测试查找此控制台日志以指示应用程序已渲染一次
    // We use console.debug to bypass our logging library which hides some log levels in prod builds
    console.debug("App 已渲染");
  }, []);
  return <>{props.children}</>;
}

export type MainParams = {
  dataSources?: IDataSourceFactory[];
  extraProviders?: JSX.Element[];
  rootElement?: JSX.Element;
};

export async function main(getParams: () => Promise<MainParams> = async () => ({})): Promise<void> {
  log.debug("initializing");

  window.onerror = (...args) => {
    console.error(...args);
  };

  const rootEl = document.getElementById("root");
  if (!rootEl) {
    throw new Error("missing #root element");
  }

  const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)\./);
  const chromeVersion = chromeMatch ? parseInt(chromeMatch[1] ?? "", 10) : 0;
  const isChrome = chromeVersion !== 0;

  const canRender = canRenderApp();
  const banner = (
    <CompatibilityBanner
      isChrome={isChrome}
      currentVersion={chromeVersion}
      isDismissable={canRender}
    />
  );

  if (!canRender) {
    // 老的写法
    // ReactDOM.render(
    //   <StrictMode>
    //     <LogAfterRender>
    //       <CssBaseline>{banner}</CssBaseline>
    //     </LogAfterRender>
    //   </StrictMode>,
    //   rootEl,
    // );
    createRoot(rootEl).render(
      <StrictMode>
        <LogAfterRender>
          <CssBaseline>{banner}</CssBaseline>
        </LogAfterRender>
      </StrictMode>,
    );
    return;
  }

  // 使用异步导入延迟加载大部分studio基本代码，直到可以显示CompatibilityBanner。
  const { installDevtoolsFormatters, overwriteFetch, waitForFonts, initI18n, StudioApp } =
    await import("@foxglove/studio-base");

  installDevtoolsFormatters();
  overwriteFetch();
  // 考虑将waitForFonts移动到应用程序中以显示应用程序加载屏幕
  await waitForFonts();
  // 是一个用于国际化（i18n）的函数
  await initI18n();

  const { WebRoot } = await import("./WebRoot");

  const params = await getParams();
  console.log("getParams", params);

  // 这是三元表达式的简写，这个时候dataSources为空
  const rootElement = params.rootElement ?? (
    <WebRoot extraProviders={params.extraProviders} dataSources={params.dataSources}>
      <StudioApp />
    </WebRoot>
  );

  createRoot(rootEl).render(
    <StrictMode>
      <LogAfterRender>
        {banner}
        {rootElement}
      </LogAfterRender>
    </StrictMode>,
  );
}
