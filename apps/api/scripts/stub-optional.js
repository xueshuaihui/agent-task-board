/**
 * Nest 可选 peer 依赖的哑桩（bundle-sidecar.mjs 的 alias 目标）。
 * Nest 在包内顶层就解构这些可选包（loadPackage 模式），桩必须可安全 require；
 * 属性全部 undefined——本项目未使用相关功能（校验走 zod、无微服务/WS 网关），
 * 若将来误用会拿到 undefined 而报错，届时应安装真包并从 alias 移除。
 */
module.exports = new Proxy(
  {},
  {
    get: () => undefined,
  },
);
