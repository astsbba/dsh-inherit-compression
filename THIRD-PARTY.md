# 出处与第三方声明

## 出处

- 项目：[dsh-retrace](https://github.com/yamingmou/dsh-retrace)
- 版本：0.4.150
- 许可：MIT，全文见本仓库根目录 `LICENSE`（版权行 `Copyright (c) 2025 dsh-retrace contributors`）

按 MIT 的要求，保留上述版权与许可声明。本项目的功能是「会话继承与上下文压缩」：锚点在消息上、到线把其后的对话压成一块记忆、原地撤回原文、把记忆交给下一轮，另含启动前瘦身与跳回锚点。这些由本项目自己实现；部分底层机制与界面骨架参考了上面那个项目。

## 其它

- 包名、补丁行 id、客户端模块 id 为 `dsh-inherit-compression`。
- 会话里已经写下的功能标识保持原样：`retrace-` 标记前缀、`retrace/marker` 事件类型、`retrace-audit` 审计键、`/api/plugins/retrace` 路由——它们与既有会话的标记绑定，改了旧标记就认不出来了。
