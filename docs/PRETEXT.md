# Pretext 原理与 openwps 接入说明

## 1. 核心定位

`@chenglou/pretext` 不是完整的富文本引擎，而是一个高性能、多语言文本测量与断行内核。

它最核心的价值是：

1. 不依赖 DOM reflow 就能测量多行文本
2. 把“文本准备”和“布局计算”拆开
3. 让后续重排变成纯算术过程

对于 openwps，这正是分页系统最需要的能力。

## 2. 总体思路

Pretext 把文本布局拆成两步：

### 2.1 `prepare()` / `prepareWithSegments()`

只做一次的预处理：

- 规范化空白字符
- 使用 `Intl.Segmenter` 做分段
- 处理标点粘连、CJK 禁则等断行规则
- 用 Canvas `measureText()` 测量段宽
- 为后续可能发生的字符级断开缓存 grapheme 宽度

这一步的产物与容器宽度无关。

### 2.2 `layout()` / `layoutWithLines()` / `layoutNextLine()`

真正排版时，只基于缓存好的宽度做行计算：

- 给一个 `maxWidth`
- 顺序累加 segment 宽度
- 超宽就寻找合法断点
- 返回行数、总高度、或逐行结果

所以当宽度变化时，通常不需要重新 `prepare`，只需要重新 `layout`。

## 3. 内部模块

### 3.1 `analysis.ts`

负责把文本转成“可排版段流”。

关键事情：

- 支持 `white-space: normal` 与 `pre-wrap`
- 用 `Intl.Segmenter` 做语言感知切分
- 给每个 segment 标记类型：
  - `text`
  - `space`
  - `preserved-space`
  - `tab`
  - `soft-hyphen`
  - `hard-break`
  - `zero-width-break`
  - `glue`
- 处理 CJK kinsoku 禁则
- 处理左粘连标点、引号、某些阿拉伯语标点等特殊情况

这一层解决“哪里可以断”“哪些字符应跟前后粘住”的问题。

### 3.2 `measurement.ts`

负责测量 segment 宽度。

关键机制：

- 优先使用 `OffscreenCanvas`，否则退回普通 `canvas`
- 用 `ctx.measureText()` 测量
- 以 `font -> segment -> metrics` 缓存结果
- 对 emoji 宽度做浏览器校准
- 对可断开的长 segment 记录 grapheme 宽度与 prefix 宽度

这一层解决“每一段到底有多宽”的问题。

### 3.3 `line-break.ts`

负责断行。

关键逻辑：

- 逐段累加当前行宽
- 如果超宽，优先回退到最近合法断点
- 如果单个 segment 本身就超宽，则退化到 grapheme 级断行
- 单独处理：
  - `soft-hyphen`
  - `tab`
  - 尾部空格
  - 硬换行
- 区分：
  - `fit width`
  - `paint width`

这里是 Pretext 最接近“排版器”的部分。

### 3.4 `layout.ts`

这是对外 API 层。

最常用接口：

- `prepare(text, font, options)`
- `prepareWithSegments(text, font, options)`
- `layout(prepared, maxWidth, lineHeight)`
- `layoutWithLines(prepared, maxWidth, lineHeight)`
- `walkLineRanges(prepared, maxWidth, onLine)`
- `layoutNextLine(prepared, cursor, maxWidth)`

区别是：

- `layout` 最轻，只求行数和高度
- `layoutWithLines` 返回逐行文本
- `walkLineRanges` 返回逐行几何范围，但不做文本拼接
- `layoutNextLine` 允许一行一行推进，适合可变宽度流布局

## 4. 为什么它适合 openwps

openwps 当前最核心的版面需求是：

1. 知道某段文本在版心宽度里会占几行
2. 据此决定这一段会消耗多少页面高度
3. 页面配置变化时能快速重算

Pretext 非常适合这个场景，因为它：

- 不依赖 DOM 实时测高
- 可缓存
- 支持中英文混排
- 支持逐行布局
- 能作为分页器的文本测量内核

## 5. openwps 当前如何接入

当前分页代码位于 `[src/layout/paginator.ts](/Users/luxiuzhe/Desktop/openwps/src/layout/paginator.ts)`。

当前实现方式是：

1. 取段落文本和段内代表性字体样式
2. 生成 Canvas font 字符串
3. 调用 `prepareWithSegments`
4. 调用 `layoutWithLines(prepared, contentWidth, lineHeight)`
5. 根据行数和段前段后间距得到段落高度
6. 按 block 粒度分页

这意味着当前分页器的本质是：

- 段内断行由 Pretext 负责
- 页内装配由 openwps 自己负责
- 当前分页粒度是 block，而不是行

## 6. 当前实现里的一个关键业务策略

在 `[src/layout/paginator.ts](/Users/luxiuzhe/Desktop/openwps/src/layout/paginator.ts)` 中，项目为了贴近编辑器里的 `word-break: break-all`，会把文本处理成：

```ts
text.split('').join('\u200b')
```

这样做的目的，是让 Pretext 在中文、英文、数字混排时也能更自由地断开，避免长数字串或英文串把前面的中文整段带走。

这是一种业务层策略，不是 Pretext 默认语义。

好处是更贴近当前编辑器视觉结果；代价是它改变了原始文本的自然断词方式。

## 7. 当前能力与限制

### 7.1 已经做得好的地方

- 避开 DOM reflow 测量
- 多页分页能稳定重算
- 中文正文场景适配较好
- 可以支持气泡宽度收缩、AI 消息布局这类额外场景

### 7.2 当前限制

- 不能把超长段落按“行”拆开跨页
- 图片和表格不是由 Pretext 原生排版，只是组合到整体高度估算里
- inline 图片、复杂富文本混排还没有形成统一的行盒模型
- 目前主要使用的是 `layoutWithLines`，还没有深用 `layoutNextLine`

## 8. 如果后续所有页面都依赖 Pretext，建议路线

### 8.1 短期

- 把 Pretext 固定为唯一文本测量来源
- 不再引入 DOM 高度读取作为分页主依据
- 把 font、lineHeight、white-space、break 策略收敛到统一入口

### 8.2 中期

- 把分页从 block 级升级到 line 级
- 段落先展开成 line boxes，再装入页面
- 支持长段落跨页
- 支持孤行寡行控制、标题连带等规则

### 8.3 长期

- 利用 `layoutNextLine` 做可变宽度文本流
- 支持双栏、多栏、图文绕排、边栏批注
- 让文本区不再局限于固定矩形版心

## 9. 对 openwps 的结论

Pretext 对 openwps 的正确定位不是“一个小工具库”，而是：

- 文本测量内核
- 文本断行内核
- 未来页面流排版的基础设施

后续如果我们要继续增强页面系统，正确方向不是绕开 Pretext，而是让分页器和页面引擎更深入地建立在它的逐行能力之上。
