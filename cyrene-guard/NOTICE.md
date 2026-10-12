# 授权

本插件的检测规则取自 **Unclecheng-li/DeepSec** 的 Shield，MIT，
<https://github.com/Unclecheng-li/DeepSec>。

从 TypeScript 移植到 JavaScript，并修了原版两处会导致误报的问题（`exec(` 的语言门控、
以及声明了但没执行的 `languages` 字段）。细节见仓库根目录的 [NOTICE.md](../NOTICE.md)。

引擎与适配部分是本项目自己的代码，MIT。

---

⚠️ 完整的三方署名与**游戏素材的排除声明**在根目录 [NOTICE.md](../NOTICE.md) —— 那一节
比这份重要，因为素材不在任何授权范围内。
