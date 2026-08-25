// 全局模块声明：OpenSumi 的 .less/.css 副作用导入在 tsgo 下需要声明
//（allowArbitraryExtensions 不覆盖副作用导入 `import "./x.less"`）。
declare module "*.less";
declare module "*.css";
