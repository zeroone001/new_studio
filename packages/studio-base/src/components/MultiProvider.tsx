// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PropsWithChildren } from "react";

/**
 * 减少了用多个React上下文提供程序包装子树所需的嵌套量。
 * 所有提供程序都可以在平面数组中传递，而不是在下一个提供程序中缩进每个提供程序
 * 到MultiProvider。
 */
export default function MultiProvider({
  children,
  providers,
}: PropsWithChildren<{ providers: readonly JSX.Element[] }>): JSX.Element {
  // reduceRight()方法的功能和reduce()功能是一样的，不同的是reduceRight()从数组的末尾向前将数组中的数组项做累加
  // 为啥一开始不用push + reduce()，而是用reduceRight()呢？
  const wrapped = providers.reduceRight(
    (wrappedChildren, provider) => React.cloneElement(provider, undefined, wrappedChildren),
    children,
  );
  // TS requires our return type to be Element instead of Node
  return <>{wrapped}</>;
}
