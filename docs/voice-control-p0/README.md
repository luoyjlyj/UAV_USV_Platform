# Voice Control P0：成员四测试基线

状态：阶段 A 草稿，尚未表示 P0 已通过。

本目录由成员四维护，用于保存语音控制 P0 的契约基线、fixtures、测试追踪和验收证据。正式实现前，K01—K06 必须由接口生产方、消费方和成员四共同确认，并在本目录留下版本记录。

## 当前前置交付

- `test-traceability.md`：76 条基线用例及新增契约覆盖点的追踪模板；
- `fake-runner-p0.py`：独立、确定性的 Java-Python 协议替身；
- `../../algorithm-service/tests/test_fake_runner_p0.py`：Fake Runner 的协议回归测试。

## 阶段 A 约束

1. Fake Runner 只验证进程协议和故障语义，不复制真实算法业务代码。
2. 任何尚未冻结的字段、错误码或状态转换只能标记为 `DRAFT`，不能作为生产契约使用。
3. 测试必须区分“发送次数”和“实际应用次数”。
4. `TIMEOUT` 代表结果未知，不得由测试工具自动重发运动命令。
5. 真实 Runner、Java 调度器和 Unity 展示合并后，沿用相同 fixtures 替换 Fake Runner 做交叉联调。

## 运行

在 `algorithm-service` 目录执行：

```text
python -m pytest tests/test_fake_runner_p0.py
```

Fake Runner 是 NDJSON 子进程，stdout 只输出协议事件，诊断信息输出 stderr。测试使用固定的 `runtimeRef`、`runtimeGeneration` 和 `commandId`，不依赖网络、数据库或真实算法适配器。
