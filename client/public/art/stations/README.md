# 工作台站点图标

最终素材：`atlas.png`。使用内置 `image_gen.imagegen` 生成，未使用 CLI。九个图标按 3 × 3 网格排列，页面文字和实时状态由前端独立渲染。

最终素材提示规格：

> Create a square transparent 3-by-3 sprite atlas for a clean, light, pearl-white and blue visual workflow workbench. Each cell contains one compact tactile isometric station icon, same camera angle and scale, generous safe padding, soft controlled shadows. Reading order: message bubbles; branching routing gateway; movie clapperboard; stacked image canvases; report document; blue lightning on a processor; layered complex processor; amber queue tickets; two execution monitors. White ceramic surfaces, cobalt blue accents, subtle translucent details. No words, letters, numbers, labels, card backgrounds, connecting lines, scenery, buildings or decorative islands. Keep every icon centered entirely within its own equal-size cell. Transparent background.

CSS 只改变背景定位，不改变素材本身；执行、排队、待答复与当前节点标记均来自实时数据。
