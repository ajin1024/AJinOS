# 岛屿插画资产

使用内置 image_gen 生成。风车是材质、镜头和照明的风格基准，其余 12 张分别生成，包含 10 套项目岛和 3 座公共岛。PNG 保存透明原图，WebP 仅做格式编码和体积优化，保留透明通道。

运行时由 client/build.mjs 将 WebP 打包到本地前端，不依赖图片服务。岛屿采用固定等距视角插画，支持平移、缩放与点击配置；任务轨道和实时状态来自中台数据。插画中的机器人和建筑本身为静态美术，不表示实时执行进度。

完整生成提示词见 prompts.json。中央调度港新增 codex-port、claude-port、entry-port 三张资产，分别表示两种 AI 执行工作坊与任务入口；该批提示词见 harbor-prompts.json。共 16 张资产，运行中为独立岛屿组合，设计参考在 client/designs/task-flow-v2/B-dispatch-harbor.png。
