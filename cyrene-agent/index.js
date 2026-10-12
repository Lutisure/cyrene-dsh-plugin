/**
 * dsh-cyrene-agent — 宿主半体（锚点）。
 *
 * **这个文件刻意什么都不做。** 它存在的唯一理由是让 `dsh plugin add` 能把这个包
 * 装进 profile 的 bundle 列表：DSH 的 loader 要求一个 bundle 必须声明
 * `dsh.bundle.patch`，否则会**静默跳过**它（不报错，只是没加载）。
 *
 * 真正干活的逻辑是**预设级插件**，由 `dist/cordis.patch.yml` 里的 preset 挂载：
 *
 *   - `cyrene-agent/worldbook` —— 设定库（触发词命中注入）
 *
 * 这样安排有个实际好处：**预设 YAML 的改动在新建会话时热生效，不用重启**，
 * 而插件源码的改动必须重启（loader 用裸 import()，没有缓存击穿）。设定库是要
 * 反复调的东西，放在预设那一侧迭代成本低得多。
 */

/** 插件 id，与 package.json 的 dsh.id、cordis.patch.yml 的条目 id 保持一致。 */
export const name = 'cyrene-agent';

/** 不注入任何宿主服务：缺少可选服务时插件仍应正常加载。 */
export const inject = [];

/**
 * 加载钩子。只写一行日志，便于确认 loader 真的读到了这个包。
 * @param {object} ctx - Cordis 上下文。
 * @returns {void}
 */
export function apply(ctx) {
  ctx?.logger?.info?.(
    '[cyrene-agent] 锚点已加载。设定库由预设挂载（cyrene-agent/worldbook）——' +
      '若预设列表里看不到「昔涟」，说明 profile 补丁里的 preset 行没生效。'
  );
}
